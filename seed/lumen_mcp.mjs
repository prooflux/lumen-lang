#!/usr/bin/env node
// `lumen-mcp`: a Model Context Protocol server (stdio, JSON-RPC 2.0) that exposes the warm
// Lumen compiler to any MCP-capable model, local or cloud. It embeds compiler_core directly,
// so the compiler is assembled once and every tool call is a hot, sub-millisecond compile.
// Zero new dependencies: the MCP framing is hand-rolled (newline-delimited JSON-RPC), keeping
// the toolchain self-contained on top of the existing `wabt` bootstrap assembler.
//
// Tools: lumen_check, lumen_fix, lumen_run, lumen_ir, lumen_explain, lumen_batch, lumen_profile,
// lumen_symbols.
//
// Daemon proxy: when the warm `lumend` daemon (lumend.mjs) is listening on its Unix socket,
// lumen_check/lumen_run/lumen_ir/lumen_batch are served through it instead of the in-process
// compiler, so every MCP client (every agent) shares one warm compiler and one compile cache
// instead of paying its own cold-start. Any socket error (no daemon, timeout, malformed
// response) falls back silently to the in-process path below -- the daemon is purely an
// accelerator, never a hard dependency. lumen_fix and lumen_explain stay in-process: fix
// iterates several compiles per call (cheap already, and the daemon's `fix` op would need the
// same iterate-until-clean loop duplicated for no latency win over one round-trip).
import readline from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import wabtInit from 'wabt';
import { createCompiler, SRC_BASE } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes, fixableCount, explain } from './diagnostics.mjs';
import { cacheKey, CACHE_DIR_PATH } from './cache.mjs';

const lumen = await createCompiler();

const SOCK = process.env.LUMEND_SOCK || path.join(os.tmpdir(), 'lumen.sock');
const DAEMON_TIMEOUT_MS = 250;

// Content-addressed cache read/write, reusing cache.mjs's key scheme (source + compiler
// identity + kind) but exposed here because the daemon path needs to check/populate the cache
// around an *async* compute step, and withCache() only accepts a synchronous computeFn.
function cacheRead(kind, src) {
  if (process.env.LUMEN_NO_CACHE === '1') return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR_PATH, `${cacheKey(src, kind)}.json`), 'utf8')); }
  catch { return undefined; }
}
function cacheWrite(kind, src, result) {
  if (process.env.LUMEN_NO_CACHE === '1') return;
  try { fs.mkdirSync(CACHE_DIR_PATH, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR_PATH, `${cacheKey(src, kind)}.json`), JSON.stringify(result)); }
  catch { /* best-effort: a write failure must not break compilation */ }
}

// Send one or more requests (each needs a unique `id`) to lumend over its Unix socket in a
// single connection, and resolve once a response has arrived for every request -- this is
// what makes lumen_batch "one round-trip for N checks" against the daemon. Rejects (so the
// caller can fall back) on connect failure, timeout, or a closed socket before all ids answer.
function daemonRPC(reqs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const sock = net.connect(SOCK);
    const responses = new Map();
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); done(reject, new Error('lumend: timeout')); }, DAEMON_TIMEOUT_MS);
    sock.on('connect', () => { for (const r of reqs) sock.write(JSON.stringify(r) + '\n'); });
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try { const resp = JSON.parse(line); responses.set(resp.id, resp); } catch { /* ignore malformed line */ }
      }
      if (responses.size >= reqs.length) { sock.end(); done(resolve, reqs.map(r => responses.get(r.id))); }
    });
    sock.on('error', e => done(reject, e));
    sock.on('close', () => done(reject, new Error('lumend: closed early')));
  });
}

// checkViaDaemon/runViaDaemon/irViaDaemon: cache-first, daemon-second, in-process-fallback-third.
async function checkViaDaemon(src) {
  const cached = cacheRead('check', src);
  if (cached) return cached;
  let result;
  try {
    const [r] = await daemonRPC([{ id: 1, op: 'check', src }]);
    if (!r || r.error) throw new Error((r && r.error) || 'lumend: no response');
    result = { ok: r.ok, irWords: r.irWords, fixable: r.fixable, diagnostics: r.diagnostics };
  } catch {
    const c = lumen.compile(src); const d = buildDiagnostics(c.rawDiags, src);
    result = { ok: d.length === 0, irWords: c.irWords, fixable: fixableCount(d), diagnostics: d };
  }
  cacheWrite('check', src, result);
  return result;
}
async function runViaDaemon(src) {
  const cached = cacheRead('run', src);
  if (cached) return cached;
  let result;
  try {
    const [r] = await daemonRPC([{ id: 1, op: 'run', src }]);
    if (!r || r.error) throw new Error((r && r.error) || 'lumend: no response');
    result = { ok: r.ok, stdout: r.stdout, diagnostics: r.diagnostics };
  } catch {
    const r = lumen.run(src);
    result = { ok: r.ok, stdout: r.stdout, diagnostics: buildDiagnostics(r.rawDiags, src) };
  }
  cacheWrite('run', src, result);
  return result;
}
async function irViaDaemon(src) {
  const cached = cacheRead('ir', src);
  if (cached) return cached;
  let result;
  try {
    const [r] = await daemonRPC([{ id: 1, op: 'ir', src }]);
    if (!r || r.error) throw new Error((r && r.error) || 'lumend: no response');
    result = { ok: r.ok, ir: r.ir, diagnostics: r.diagnostics };
  } catch {
    const r = lumen.ir(src);
    result = { ok: r.ok, ir: r.ok ? r.text : '', diagnostics: buildDiagnostics(r.rawDiags, src) };
  }
  cacheWrite('ir', src, result);
  return result;
}

// lumen_batch: N sources, one MCP round-trip. Cache-hits never touch the daemon; the rest go
// out as one batched daemonRPC() call (one socket connection, N pipelined requests, N
// responses) and fall back to an in-process loop together if the daemon is unavailable.
async function batchCheck(sources) {
  if (!Array.isArray(sources)) throw new Error('lumen_batch: sources must be an array');
  if (sources.length > 200) throw new Error('lumen_batch: cap is 200 sources');
  const results = new Array(sources.length);
  const pending = [];
  sources.forEach((src, idx) => {
    const cached = cacheRead('check', src);
    if (cached) results[idx] = { ok: cached.ok, diagnostics: cached.diagnostics };
    else pending.push({ idx, src });
  });
  if (pending.length) {
    let daemonOk = true;
    try {
      const reqs = pending.map((p, i) => ({ id: i, op: 'check', src: p.src }));
      const resps = await daemonRPC(reqs);
      resps.forEach((r, i) => {
        const { idx, src } = pending[i];
        if (!r || r.error) throw new Error((r && r.error) || 'lumend: no response');
        const result = { ok: r.ok, irWords: r.irWords, fixable: r.fixable, diagnostics: r.diagnostics };
        cacheWrite('check', src, result);
        results[idx] = { ok: result.ok, diagnostics: result.diagnostics };
      });
    } catch { daemonOk = false; }
    if (!daemonOk) {
      for (const { idx, src } of pending) {
        if (results[idx]) continue;
        const c = lumen.compile(src); const d = buildDiagnostics(c.rawDiags, src);
        const result = { ok: d.length === 0, irWords: c.irWords, fixable: fixableCount(d), diagnostics: d };
        cacheWrite('check', src, result);
        results[idx] = { ok: result.ok, diagnostics: result.diagnostics };
      }
    }
  }
  return { results };
}

// lumen_profile: exact, reproducible cost accounting. Runs on a *fresh* instance (not the
// shared warm `lumen` compiler, not the daemon) because profiling counters live at fixed
// memory offsets [600000,700000) inside the instrumented VM and must start zeroed for this
// call alone -- a shared/warm instance could be mid-flight on another request's memory.
// Deterministic (same source -> same steps/calls every time), so it is cache-friendly:
// keyed the same way as check/run/ir, via the same cacheRead/cacheWrite helpers above.
// buildReport: runs profile_report.lm (the report engine, written in Lumen itself -- see
// seed/profile_report.lm) on a brand-new WASM instance, injecting the {calls, name} records
// per its documented protocol (600000: n, 600004+i*12: [calls,name_ptr,reserved], name blobs
// in [640000,690000)) and capturing its stdout directly (bypassing compiler_core's run()
// wrapper, which only exposes stdout for sources it compiles+runs itself in one call -- here
// we need to inject memory *between* compile and run).
const PROFILE_REPORT_SRC = fs.readFileSync(new URL('./profile_report.lm', import.meta.url), 'utf8');
let _wabt;
async function buildReport(funcs) {
  _wabt = _wabt || await wabtInit();
  const wat = fs.readFileSync(new URL('./lumenc.wat', import.meta.url), 'utf8');
  const binary = _wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  const ex = instance.exports;
  const bytes = Buffer.from(PROFILE_REPORT_SRC, 'utf8');
  new Uint8Array(ex.mem.buffer, SRC_BASE, bytes.length).set(bytes);
  ex.compile(bytes.length);
  if (ex.dbg_nerr() > 0) return '';
  const main = ex.dbg_main();

  const m32 = new Int32Array(ex.mem.buffer);
  const m8 = new Uint8Array(ex.mem.buffer);
  const dv = new DataView(ex.mem.buffer);
  const n = Math.min(funcs.length, 5000);   // guard: keeps records well inside [600004, 640000)
  m32[600000 / 4] = n;
  let nameAddr = 640000;
  for (let i = 0; i < n; i++) {
    const nameBytes = Buffer.from(funcs[i].name, 'utf8');
    const blobLen = 4 + nameBytes.length;
    if (nameAddr + blobLen > 690000) break;   // name-blob region exhausted; stop, report what fits
    dv.setInt32(nameAddr, nameBytes.length, true);
    m8.set(nameBytes, nameAddr + 4);
    const rec = 600004 + i * 12;
    m32[rec / 4] = funcs[i].calls;
    m32[rec / 4 + 1] = nameAddr;
    m32[rec / 4 + 2] = 0;
    nameAddr += blobLen;
  }

  out = '';
  if (ex.set_fuel_max) ex.set_fuel_max(4000000000n);
  try { ex.run(main); } catch { return out; }
  return out;
}

async function profileSource(src, opts = {}) {
  const wantReport = !!opts.report;
  const cached = cacheRead('profile', src);
  if (cached && (!wantReport || cached.report !== undefined)) return cached;
  const fresh = await createCompiler();
  const ex = fresh.exports;
  const c = fresh.compile(src);
  if (!c.ok) {
    const result = { ok: false, diagnostics: buildDiagnostics(c.rawDiags, src) };
    cacheWrite('profile', src, result);
    return result;
  }
  // symbol table: entries at [150000,157000), 12 bytes each (name_off, name_len, entry).
  // name_off points into the SRC region [100000,150000) -- see selfhost_diff.mjs.
  const memB = new DataView(ex.mem.buffer);
  const u8B = new Uint8Array(ex.mem.buffer);
  const funcs = [];
  for (let addr = 150000; addr < 157000; addr += 12) {
    const name_off = memB.getInt32(addr, true);
    const name_len = memB.getInt32(addr + 4, true);
    const entry = memB.getInt32(addr + 8, true);
    if (name_off >= 100000 && name_off < 150000 && name_len > 0) {
      const name = Buffer.from(u8B.slice(name_off, name_off + name_len)).toString('utf8');
      funcs.push({ name, entry });
    }
  }
  if (ex.set_fuel_max) ex.set_fuel_max(4000000000n);
  ex.set_prof(1);
  try { ex.run(c.main); }
  catch (e) {
    const result = { ok: false, diagnostics: [], crash: String(e.message || e) };
    cacheWrite('profile', src, result);
    return result;
  }
  const totalSteps = ex.get_last_steps();
  const seen = new Set();
  const functions = [];
  for (const f of funcs) {
    if (seen.has(f.entry)) continue;   // a function can have >1 symtab record; count it once
    seen.add(f.entry);
    functions.push({ name: f.name, entry: f.entry, calls: ex.prof_count(f.entry) });
  }
  functions.sort((a, b) => b.calls - a.calls);
  const result = { ok: true, totalSteps: totalSteps.toString(), functions };
  if (wantReport) result.report = await buildReport(functions);
  cacheWrite('profile', src, result);
  return result;
}

// lumen_symbols: outline a source's top-level functions for agent navigation (name, entry
// address, source line, and the declaring line's text). Reuses the same symbol-table layout
// as selfhost_diff.mjs / profileSource: entries at [150000,157000), 12 bytes each
// (name_off, name_len, entry), name bytes in the SRC region [100000,150000). `line` is found
// by locating the first `fn <name>(` occurrence in the source and counting newlines before it
// (1-indexed); `signature` is that occurrence's full source line text.
function lineAndSignature(src, name) {
  const marker = `fn ${name}(`;
  const idx = src.indexOf(marker);
  if (idx === -1) return { line: -1, signature: '' };
  const before = src.slice(0, idx);
  const lineStart = before.lastIndexOf('\n') + 1;
  let lineEnd = src.indexOf('\n', idx);
  if (lineEnd === -1) lineEnd = src.length;
  const line = (before.match(/\n/g) || []).length + 1;
  return { line, signature: src.slice(lineStart, lineEnd) };
}
function symbolsFromSource(src) {
  const cached = cacheRead('symbols', src);
  if (cached) return cached;
  const c = lumen.compile(src);
  if (!c.ok) {
    const result = { ok: false, symbols: [], diagnostics: buildDiagnostics(c.rawDiags, src) };
    cacheWrite('symbols', src, result);
    return result;
  }
  const ex = lumen.exports;
  const memB = new DataView(ex.mem.buffer);
  const u8B = new Uint8Array(ex.mem.buffer);
  const seen = new Set();
  const symbols = [];
  for (let addr = 150000; addr < 157000; addr += 12) {
    const name_off = memB.getInt32(addr, true);
    const name_len = memB.getInt32(addr + 4, true);
    const entry = memB.getInt32(addr + 8, true);
    if (name_off >= 100000 && name_off < 150000 && name_len > 0) {
      if (seen.has(entry)) continue;   // a function can have >1 symtab record; list it once
      seen.add(entry);
      const name = Buffer.from(u8B.slice(name_off, name_off + name_len)).toString('utf8');
      const { line, signature } = lineAndSignature(src, name);
      symbols.push({ name, entry, line, signature });
    }
  }
  symbols.sort((a, b) => a.entry - b.entry);
  const result = { ok: true, symbols };
  cacheWrite('symbols', src, result);
  return result;
}

const TOOLS = [
  { name: 'lumen_check', description: 'Compile Lumen source and return structured diagnostics (the canonical Diagnostic stream). Empty diagnostics means it compiles.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', description: 'Lumen (.lm) source' } }, required: ['source'] } },
  { name: 'lumen_fix', description: 'Apply the compiler\'s confident fixes to Lumen source (delete an unexpected token, close an unterminated block) and return the repaired source plus any remaining diagnostics.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_run', description: 'Compile and run Lumen source; return its stdout, or diagnostics if it does not compile.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_ir', description: 'Compile Lumen source and return the IR disassembly (one instruction per line).',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
  { name: 'lumen_explain', description: 'Explain a Lumen diagnostic code (e.g. E0003).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'lumen_batch', description: 'Compile up to 200 Lumen sources in one round-trip; returns {ok, diagnostics} per source, in order.',
    inputSchema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'string' }, description: 'Up to 200 Lumen (.lm) sources' } }, required: ['sources'] } },
  { name: 'lumen_profile', description: 'Compile and run Lumen source with exact, reproducible cost accounting: total interpreter steps and per-function call counts (sorted by calls desc). Returns diagnostics if it does not compile. Pass report:true to also render a human-readable top-10-by-calls report, generated by profile_report.lm (a Lumen program, not a JS formatter).',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, report: { type: 'boolean', description: 'also return a `report` field: a rendered top-10-by-calls text report produced by running profile_report.lm' } }, required: ['source'] } },
  { name: 'lumen_symbols', description: 'Outline a Lumen source\'s top-level functions for agent navigation: name, symbol-table entry address, source line, and the declaring line\'s text.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } },
];

async function callTool(name, args) {
  const src = (args && args.source) || '';
  if (name === 'lumen_check') return await checkViaDaemon(src);
  if (name === 'lumen_fix') {
    let cur = src, applied = 0, rounds = 0;
    while (rounds++ < 20) {
      const c = lumen.compile(cur); const d = buildDiagnostics(c.rawDiags, cur);
      if (!d.length) break;
      const r = applyFixes(cur, d);
      if (r.applied === 0 || r.source === cur) break;
      cur = r.source; applied += r.applied;
    }
    const fc = lumen.compile(cur);
    return { source: cur, applied, diagnostics: buildDiagnostics(fc.rawDiags, cur) };
  }
  if (name === 'lumen_run') return await runViaDaemon(src);
  if (name === 'lumen_ir') return await irViaDaemon(src);
  if (name === 'lumen_explain') {
    const reg = explain((args && args.code) || ''); return reg ? { code: reg.id, msg: reg.msg, explain: reg.explain } : { error: 'unknown code' };
  }
  if (name === 'lumen_batch') return await batchCheck((args && args.sources) || []);
  if (name === 'lumen_profile') return await profileSource(src, { report: !!(args && args.report) });
  if (name === 'lumen_symbols') return symbolsFromSource(src);
  throw new Error(`unknown tool ${name}`);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

// dispatch is async because tools/call may hit the daemon over a socket; every other method
// resolves synchronously in practice but is still returned via the async function's implicit
// Promise, so all callers (stdio loop below, loop_test.mjs) must `await` it.
export async function dispatch(req) {
  const { id, method, params } = req;
  if (method === 'initialize')
    return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lumen-mcp', version: '0.1.0' } } };
  if (method === 'notifications/initialized' || method === 'initialized') return null;   // notification
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const out = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } };
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return null;
}

// stdio loop (skipped when imported for testing)
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let req; try { req = JSON.parse(line); } catch { return; }
    const resp = await dispatch(req);
    if (resp) send(resp);
  });
  process.stderr.write(`lumen-mcp: warm in ${lumen.assembleMs.toFixed(1)}ms, ready on stdio\n`);
}
