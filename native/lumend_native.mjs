#!/usr/bin/env node
// `lumend_native`: the warm NATIVE compiler daemon. The native equivalent of seed/lumend.mjs -
// same protocol shape, same Unix-socket transport, but backed by the R3 resident native compiler
// (native/native_compile.mjs's getResidentCompiler()/checkNativeResident()/
// compileToIRNativeResidentFullRaw()) instead of the wasm seed.
//
// Why this exists: getResidentCompiler() already avoids paying the native binary's process-spawn
// cost PER COMPILE, but only within the lifetime of the ONE Node process that calls it - every
// fresh `node ...` invocation (e.g. a new CLI command) spawns a brand-new resident child on its
// first call, so a fair "Lumen compiles faster than gcc/clang" comparison must be daemon-vs-daemon
// (a cold gcc/clang invocation ALSO pays process startup - see this file's task brief), not
// daemon-vs-cold. This module makes the resident compiler outlive any single client process by
// hosting it behind a persistent Unix-domain socket server, exactly the way seed/lumend.mjs makes
// the wasm compiler persistent: one warm process, many short-lived client connections.
//
//   node lumend_native.mjs [socket-path]      default: $TMPDIR/lumen-native.sock
//
// Protocol: newline-delimited JSON, same envelope as seed/lumend.mjs. Request {id, op, ...};
// response {id, ...}.
//   ping                  -> {pong:true, warmMs}
//   check {src}           -> {ok, irWords, fixable, diagnostics, ms}
//   compile {src}         -> {ok, nerr, wordCount, main, fixable, diagnostics, ms}
//
// `check` mirrors seed/lumend.mjs's check op (diagnostics only, cheapest useful answer).
// `compile` additionally reports the raw IR word count and entry function index - the smallest
// superset of `check` that still proves a full compile (not just a diagnostics pass) ran. Neither
// op emits C or invokes clang: that stays a deliberately separate, heavier step (see
// native/native_compile.mjs's runIRNative/runFnNativeFull), same scope boundary
// seed/native_check.mjs's header documents for the wasm-side daemon ops.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { checkNativeResident, compileToIRNativeResidentFullRaw, getResidentCompiler } from './native_compile.mjs';
import { buildDiagnostics, fixableCount } from '../seed/diagnostics.mjs';

const SOCK = process.argv[2] || path.join(os.tmpdir(), 'lumen-native.sock');

function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

// Warm the resident native compiler once at startup (spawns the child, pays its process-startup
// cost exactly once for this daemon's whole lifetime) rather than lazily on the first client
// request, so `ping` immediately after listen() already reflects steady-state latency.
const warmStart = process.hrtime.bigint();
await checkNativeResident('fn main(c: Console) -> Unit { return () }');
const warmMs = ms(warmStart);

async function checkResult(src) {
  const t = process.hrtime.bigint();
  const r = await checkNativeResident(src);
  const diagnostics = buildDiagnostics(r.rawDiags, src);
  return { ok: diagnostics.length === 0, irWords: r.irWords, fixable: fixableCount(diagnostics), diagnostics, ms: ms(t) };
}

async function compileResult(src) {
  const t = process.hrtime.bigint();
  const r = await compileToIRNativeResidentFullRaw(src);
  const diagnostics = buildDiagnostics(r.rawDiags, src);
  return {
    ok: r.nerr === 0, nerr: r.nerr, wordCount: r.words.length, main: r.main,
    fixable: fixableCount(diagnostics), diagnostics, ms: ms(t),
  };
}

async function handle(req) {
  const id = req.id;
  switch (req.op) {
    case 'ping': return { id, pong: true, warmMs };
    case 'check': return { id, ...(await checkResult(req.src || '')) };
    case 'compile': return { id, ...(await compileResult(req.src || '')) };
    default: return { id, error: `unknown op ${req.op}` };
  }
}

try { fs.unlinkSync(SOCK); } catch {}
const server = net.createServer(sock => {
  let buf = '';
  // Same serialize-then-drain pattern as seed/lumend.mjs (handle() is async: a resident-compiler
  // round trip awaits the child's pipe) - process every complete line currently buffered before
  // yielding, and let a `pending` flag re-trigger the drain if more data arrived meanwhile, so two
  // 'data' events can never race on `buf` or interleave two in-flight handle() calls out of order.
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
server.listen(SOCK, () => { process.stderr.write(`lumend_native: warm in ${warmMs.toFixed(1)}ms, listening on ${SOCK}\n`); });

function shutdown() {
  try { fs.unlinkSync(SOCK); } catch {}
  try { getResidentCompiler().stop(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
