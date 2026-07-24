#!/usr/bin/env node
// `lumend`: the warm Lumen compiler daemon. Assembles the WASM once and keeps it hot, then
// answers structured queries over a local Unix-domain socket (no TCP, no network). The point
// is the inference-time loop: compile is sub-millisecond, so once the daemon is warm the only
// cost of a fix-round is the model's own latency. A session keeps a source buffer so a model
// sends a span-edit patch (tens of tokens) instead of resending a whole file each round.
//
//   node lumend.mjs [socket-path]      default: $TMPDIR/lumen.sock
//
// Protocol: newline-delimited JSON. Request {id, op, ...}; response {id, ...}.
//   ping                              -> {pong:true, warmMs}
//   check {src}                       -> {ok, irWords, fixable, diagnostics, ms}
//   fix   {src}                       -> {source, applied, diagnostics, ms}
//   run   {src}                       -> {ok, stdout, diagnostics, ms}
//   ir    {src}                       -> {ok, ir, diagnostics}
//   open  {session, src}              -> {ok, hash, len, diagnostics}
//   edit  {session, span:[a,b], text, baseHash} -> {ok, hash, diagnostics, ms} | {resync:true, hash}
//   close {session}                   -> {ok}
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createCompiler } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes, fixableCount } from './diagnostics.mjs';
import { checkAuto } from './native_check.mjs';

const SOCK = process.argv[2] || path.join(os.tmpdir(), 'lumen.sock');

function fnv1a(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); }
function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

const lumen = await createCompiler();
const sessions = new Map();   // session id -> source string

// R3: check is the daemon's hot loop (see the file header - "the point is the inference-time
// loop"), so it is the op re-pointed at the native resident compiler (checkAuto: native-first,
// automatic wat fallback, LUMEN_COMPILE=wat to force the old path). `run` stays on the wasm
// interpreter (native "running" means a fresh clang build per request, not a compile - out of
// scope, see seed/native_check.mjs's header). `fix`'s internal iterate-to-convergence loop and
// `ir`'s disassembly (which reads the compiled program straight out of the wasm instance's own
// memory - see compiler_core.mjs's ir()) are left on the wasm path for this round; nothing about
// their behavior changed.
async function checkResult(src) {
  const t = process.hrtime.bigint();
  const c = await checkAuto(lumen, src);
  const diagnostics = buildDiagnostics(c.rawDiags, src);
  return { ok: diagnostics.length === 0, irWords: c.irWords, fixable: fixableCount(diagnostics), diagnostics, ms: ms(t) };
}

async function handle(req) {
  const id = req.id;
  switch (req.op) {
    case 'ping': return { id, pong: true, warmMs: lumen.assembleMs };
    case 'check': return { id, ...(await checkResult(req.src || '')) };
    case 'fix': {
      const t = process.hrtime.bigint();
      let cur = req.src || '', applied = 0, rounds = 0;
      while (rounds++ < 20) {
        const c = lumen.compile(cur);
        const diags = buildDiagnostics(c.rawDiags, cur);
        if (!diags.length) break;
        const r = applyFixes(cur, diags);
        if (r.applied === 0 || r.source === cur) break;
        cur = r.source; applied += r.applied;
      }
      const fc = lumen.compile(cur);
      return { id, source: cur, applied, diagnostics: buildDiagnostics(fc.rawDiags, cur), ms: ms(t) };
    }
    case 'run': {
      const t = process.hrtime.bigint();
      // req.fuel (string, since JSON has no BigInt) optionally raises the interpreter's
      // step cap above the 4e9 default - see compiler_core.mjs's run() doc comment.
      const fuelMax = req.fuel !== undefined ? BigInt(req.fuel) : undefined;
      const r = fuelMax !== undefined ? lumen.run(req.src || '', fuelMax) : lumen.run(req.src || '');
      return {
        id, ok: r.ok, stdout: r.stdout, diagnostics: buildDiagnostics(r.rawDiags, req.src || ''), ms: ms(t),
        // Root-caused 2026-07-23: a run that silently exhausted its fuel used to look
        // identical to a successful run over the daemon RPC too - forward the fields so
        // no caller (CLI fallback, MCP) loses this signal.
        fuelExhausted: r.fuelExhausted, steps: r.steps, fuelMax: r.fuelMax,
      };
    }
    case 'ir': {
      const r = lumen.ir(req.src || '');
      return { id, ok: r.ok, ir: r.ok ? r.text : '', diagnostics: buildDiagnostics(r.rawDiags, req.src || '') };
    }
    case 'open': {
      const src = req.src || '';
      sessions.set(req.session, src);
      return { id, ok: true, hash: fnv1a(src), len: src.length, ...(await checkResult(src)) };
    }
    case 'edit': {
      const cur = sessions.get(req.session);
      if (cur === undefined) return { id, error: 'no such session' };
      if (req.baseHash && req.baseHash !== fnv1a(cur)) return { id, resync: true, hash: fnv1a(cur) };
      const [a, b] = req.span;
      if (a < 0 || b > cur.length || a > b) return { id, error: 'bad span', hash: fnv1a(cur) };
      const next = cur.slice(0, a) + (req.text || '') + cur.slice(b);
      sessions.set(req.session, next);
      return { id, ok: true, hash: fnv1a(next), ...(await checkResult(next)) };
    }
    case 'close': { sessions.delete(req.session); return { id, ok: true }; }
    default: return { id, error: `unknown op ${req.op}` };
  }
}

try { fs.unlinkSync(SOCK); } catch {}
const server = net.createServer(sock => {
  let buf = '';
  // handle() is now async (checkAuto awaits the resident compiler over its own pipe), so a
  // plain `sock.on('data', async chunk => ...)` would be re-entrant: a second 'data' event can
  // fire (and start mutating `buf`) before the first event's in-flight `await handle(...)` call
  // returns. Serialize with the same pump/busy pattern native/lumen_serve_native.mjs's socket
  // server already uses - drain every complete line currently in `buf` before yielding, and let
  // a `pending` flag re-trigger the drain if more data arrived while a request was in flight.
  let busy = false, pending = false;
  const drain = async () => {
    if (busy) { pending = true; return; }
    busy = true;
    do {
      pending = false;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let resp;
        try { resp = await handle(JSON.parse(line)); }
        catch (e) { resp = { error: String(e.message || e) }; }
        sock.write(JSON.stringify(resp) + '\n');
      }
    } while (pending);
    busy = false;
  };
  sock.on('data', chunk => { buf += chunk.toString('utf8'); drain(); });
  sock.on('error', () => {});
});
server.listen(SOCK, () => { process.stderr.write(`lumend: warm in ${lumen.assembleMs.toFixed(1)}ms, listening on ${SOCK}\n`); });
process.on('SIGINT', () => { try { fs.unlinkSync(SOCK); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.unlinkSync(SOCK); } catch {} process.exit(0); });
