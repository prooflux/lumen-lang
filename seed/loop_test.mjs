// Exercises the LLM-to-compiler loop: the structured-diagnostic + fix surface, the MCP
// dispatch, and the warm `lumend` daemon (correctness + edit-to-diagnostic latency).
// Usage: node loop_test.mjs
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dispatch } from './lumen_mcp.mjs';
import { createCompiler } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes } from './diagnostics.mjs';

let pass = 0, total = 0;
function check(name, cond, extra = '') { total++; if (cond) { pass++; console.log(`PASS  ${name}`); } else { console.log(`FAIL  ${name}  ${extra}`); } }

// ---- 1. structured diagnostics + confident fix (in-process) ----
{
  const lumen = await createCompiler();
  const broken = 'fn main(console: Console) -> Unit {\n  @\n  let x = 1\n';
  const c = lumen.compile(broken);
  const d = buildDiagnostics(c.rawDiags, broken);
  check('diagnostics: two structured diags with codes', d.length === 2 && d[0].code === 'E0003' && d[1].code === 'E0004', JSON.stringify(d));
  check('diagnostics: E0003 has accurate span + name', d[0].name === '@' && d[0].span[0] === 38, JSON.stringify(d[0]));
  const r = applyFixes(broken, d);
  const after = lumen.compile(r.source);
  check('fix: converges to a clean compile at zero round-trips', r.applied === 2 && after.rawDiags.length === 0, `applied=${r.applied}`);
}

// ---- 2. MCP dispatch (initialize / tools/list / tools/call) ----
{
  const init = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  check('mcp: initialize advertises tools capability', !!init.result.capabilities.tools && init.result.serverInfo.name === 'lumen-mcp');
  const list = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = list.result.tools.map(t => t.name);
  check('mcp: tools/list exposes the loop tools', ['lumen_check', 'lumen_fix', 'lumen_run', 'lumen_ir', 'lumen_explain', 'lumen_batch', 'lumen_profile', 'lumen_symbols'].every(n => names.includes(n)), names.join(','));
  const run = await dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lumen_run', arguments: { source: 'fn main(c: Console) -> Unit {\n  c.print("hi\\n")\n}\n' } } });
  const runOut = JSON.parse(run.result.content[0].text);
  check('mcp: lumen_run returns program stdout', runOut.ok && runOut.stdout === 'hi\n', JSON.stringify(runOut));
  const fix = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lumen_fix', arguments: { source: 'fn main(c: Console) -> Unit {\n  @\n' } } });
  const fixOut = JSON.parse(fix.result.content[0].text);
  check('mcp: lumen_fix repairs and reports remaining', fixOut.applied >= 1 && fixOut.diagnostics.length === 0, JSON.stringify(fixOut));
  const goodSrc = 'fn main(c: Console) -> Unit {\n  c.print("hi\\n")\n}\n';
  const badSrc = 'fn main(c: Console) -> Unit {\n  @\n';
  const batch = await dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lumen_batch', arguments: { sources: [goodSrc, badSrc] } } });
  const batchOut = JSON.parse(batch.result.content[0].text);
  check('mcp: lumen_batch checks N sources in one round-trip', batchOut.results.length === 2 && batchOut.results[0].ok === true && batchOut.results[1].ok === false, JSON.stringify(batchOut));

  // lumen_profile: exact deterministic cost accounting (fib_print.lm calls fib(10) recursively).
  const fibSrc = fs.readFileSync(new URL('../mu/examples/fib_print.lm', import.meta.url), 'utf8');
  const prof1 = await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'lumen_profile', arguments: { source: fibSrc } } });
  const prof1Out = JSON.parse(prof1.result.content[0].text);
  const prof2 = await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'lumen_profile', arguments: { source: fibSrc } } });
  const prof2Out = JSON.parse(prof2.result.content[0].text);
  check('mcp: lumen_profile compiles ok and reports steps + functions', prof1Out.ok && Number(prof1Out.totalSteps) > 0 && prof1Out.functions.length > 0, JSON.stringify(prof1Out));
  const fibFn = prof1Out.functions.find(f => f.name === 'fib');
  check('mcp: lumen_profile counts fib calls > 10 (fib(10) recurses)', !!fibFn && fibFn.calls > 10, JSON.stringify(fibFn));
  check('mcp: lumen_profile functions sorted by calls desc', prof1Out.functions.every((f, i) => i === 0 || prof1Out.functions[i - 1].calls >= f.calls), JSON.stringify(prof1Out.functions));
  check('mcp: lumen_profile is deterministic across runs', prof1Out.totalSteps === prof2Out.totalSteps && JSON.stringify(prof1Out.functions) === JSON.stringify(prof2Out.functions), `${prof1Out.totalSteps} vs ${prof2Out.totalSteps}`);

  // lumen_symbols: outline mutual.lm's functions (name, entry, line, signature).
  const mutualSrc = fs.readFileSync(new URL('../mu/examples/mutual.lm', import.meta.url), 'utf8');
  const sym1 = await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'lumen_symbols', arguments: { source: mutualSrc } } });
  const sym1Out = JSON.parse(sym1.result.content[0].text);
  const sym2 = await dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lumen_symbols', arguments: { source: mutualSrc } } });
  const sym2Out = JSON.parse(sym2.result.content[0].text);
  check('mcp: lumen_symbols compiles ok and lists functions', sym1Out.ok && sym1Out.symbols.length > 0, JSON.stringify(sym1Out));
  check('mcp: lumen_symbols includes main with a plausible line + signature', sym1Out.symbols.some(s => s.name === 'main' && s.line > 0 && s.signature.includes('fn main(')), JSON.stringify(sym1Out.symbols));
  check('mcp: lumen_symbols line numbers match the actual source text', sym1Out.symbols.every(s => s.line === -1 || mutualSrc.split('\n')[s.line - 1] === s.signature), JSON.stringify(sym1Out.symbols));
  check('mcp: lumen_symbols is deterministic across calls', JSON.stringify(sym1Out) === JSON.stringify(sym2Out), `${JSON.stringify(sym1Out)} vs ${JSON.stringify(sym2Out)}`);
}

// ---- 3. warm daemon: span-edit -> diagnostic latency ----
const sock = path.join(os.tmpdir(), `lumen-test-${process.pid}.sock`);
const daemon = spawn(process.execPath, [new URL('./lumend.mjs', import.meta.url).pathname, sock], { stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((res, rej) => {
  let tries = 0;
  const t = setInterval(() => {
    const s = net.connect(sock, () => { clearInterval(t); s.end(); res(); });
    s.on('error', () => { s.destroy(); if (++tries > 100) { clearInterval(t); rej(new Error('daemon did not start')); } });
  }, 50);
});

function rpc(conn, req) {
  return new Promise(resolve => { conn.once('data', d => resolve(JSON.parse(d.toString().trim().split('\n')[0]))); conn.write(JSON.stringify(req) + '\n'); });
}

const conn = net.connect(sock);
await new Promise(r => conn.on('connect', r));

const ping = await rpc(conn, { id: 1, op: 'ping' });
check('daemon: ping reports warm assemble time', ping.pong === true && typeof ping.warmMs === 'number');

const valid = 'fn add(a: Int, b: Int) -> Int {\n  return a + b\n}\nfn main(c: Console) -> Unit {\n  c.print_int(add(2, 3))\n}\n';
const opened = await rpc(conn, { id: 2, op: 'open', session: 's1', src: valid });
check('daemon: open compiles the buffer', opened.ok === true && opened.diagnostics.length === 0, JSON.stringify(opened.diagnostics));

// span-edit: break the program (insert a stray '@'), then a second edit to fix it
const lat = [];
let hash = opened.hash;
for (let i = 0; i < 60; i++) {
  // toggle: insert '@' then delete it, measuring the edit->diagnostic round trip each time
  const insAt = valid.indexOf('return');
  const t0 = process.hrtime.bigint();
  const e1 = await rpc(conn, { id: 100 + i, op: 'edit', session: 's1', span: [insAt, insAt], text: '@ ', baseHash: hash });
  lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  hash = e1.hash;
  // revert
  const e2 = await rpc(conn, { id: 200 + i, op: 'edit', session: 's1', span: [insAt, insAt + 2], text: '', baseHash: hash });
  hash = e2.hash;
  if (i === 0) check('daemon: a breaking edit yields an E0003 diagnostic', e1.diagnostics.some(d => d.code === 'E0003'), JSON.stringify(e1.diagnostics));
  if (i === 0) check('daemon: the reverting edit returns to clean', e2.diagnostics.length === 0, JSON.stringify(e2.diagnostics));
}
const resync = await rpc(conn, { id: 999, op: 'edit', session: 's1', span: [0, 0], text: 'x', baseHash: 'deadbeef' });
check('daemon: stale baseHash triggers a resync, not a corrupt edit', resync.resync === true);

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length * 0.5)], p99 = lat[Math.floor(lat.length * 0.99)];
console.log(`\nedit->diagnostic latency over ${lat.length} round trips:  p50 ${p50.toFixed(2)}ms  p99 ${p99.toFixed(2)}ms  (target p50 < 5ms)`);
check('daemon: warm edit->diagnostic p50 < 5ms', p50 < 5, `p50=${p50.toFixed(2)}ms`);

conn.end();
daemon.kill('SIGTERM');
console.log(`\n${pass}/${total} loop checks passed.`);
process.exit(pass === total ? 0 : 1);
