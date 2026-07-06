// http_serve_bench.mjs - measures the compiled-native HTTP server kernel against interpreted Python
// on identical work (parse request line -> linear-scan route table -> build the exact response).
//
// The wasm interpreter is Lumen's correctness oracle (http_serve_test.mjs), NOT its speed artifact.
// Speed is the native backend: this harness takes the SAME examples/http/http_serve.lm, rewrites its
// per-request `main` into a reusable `serve_one`, stages a fixed request + route table in raw memory,
// loops the hot path N times, and lowers the whole thing to native code via emit_fn.lm -> clang -O2.
// It then times that binary and native/http_serve_bench.py (byte-identical algorithm) with a
// two-point method that cancels process/interpreter startup, and reports iters/sec for each.
//
// Run:  node http_serve_bench.mjs [--assert]
//   --assert  exit non-zero unless the native kernel's throughput beats Python's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildAndRunFn } from './pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = fs.readFileSync(path.join(__dirname, '../examples/http/http_serve.lm'), 'utf8');
const PY = path.join(__dirname, 'http_serve_bench.py');

// Memory map - must match examples/http/http_serve.lm.
const REQ_LEN_ADDR = 590000, REQ_BASE = 590016;
const ROUTE_COUNT_ADDR = 598000, ROUTE_BASE = 598016, BLOB_BASE = 604000;

// Fixtures - byte-identical to http_serve_bench.py (same request, same routes in the same order).
const METHOD = { GET: 1, POST: 2, PUT: 3, DELETE: 4, HEAD: 5, PATCH: 6, OPTIONS: 7 };
const REQUEST = 'GET /home HTTP/1.1\r\nHost: x\r\n\r\n';
const ROUTES = [
  { method: 'GET', path: '/', status: 200, ctype: 'text/plain', body: 'hi' },
  { method: 'GET', path: '/health', status: 200, ctype: 'text/plain', body: 'ok' },
  { method: 'POST', path: '/api', status: 200, ctype: 'application/json', body: '{}' },
  { method: 'GET', path: '/home', status: 200, ctype: 'text/html; charset=utf-8', body: '<h1>Home</h1>' },
];

// The exact single-response length the kernel and the Python baseline must both produce, so the
// benchmark can never silently measure two different amounts of work.
function expectedResponseLen(req) {
  const sp1 = req.indexOf(' ');
  const sp2 = req.indexOf(' ', sp1 + 1);
  const method = req.slice(0, sp1), pathStr = req.slice(sp1 + 1, sp2);
  let r = ROUTES.find(x => x.method === method && x.path === pathStr);
  const [status, reason, ctype, body] = r
    ? [r.status, 'OK', r.ctype, r.body]
    : [404, 'Not Found', 'text/plain', 'Not Found'];
  const resp = `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${ctype}\r\n` +
    `Content-Length: ${Buffer.byteLength(body, 'latin1')}\r\nConnection: keep-alive\r\n\r\n${body}`;
  return Buffer.byteLength(resp, 'latin1');
}

// Emit a Lumen `fn stage()` that writes the request + route table into raw memory (the host's
// startup step, hand-inlined so the whole benchmark is one self-contained native program).
function genStage() {
  const lines = [];
  const reqBytes = Buffer.from(REQUEST, 'latin1');
  lines.push(`  store32(${REQ_LEN_ADDR}, ${reqBytes.length})`);
  reqBytes.forEach((b, i) => lines.push(`  store8(${REQ_BASE + i}, ${b})`));
  lines.push(`  store32(${ROUTE_COUNT_ADDR}, ${ROUTES.length})`);
  let blob = BLOB_BASE;
  const pack = (s) => {
    const bytes = Buffer.from(s, 'latin1');
    const off = blob;
    bytes.forEach((b, i) => lines.push(`  store8(${off + i}, ${b})`));
    blob += bytes.length;
    return [off, bytes.length];
  };
  ROUTES.forEach((r, i) => {
    const base = ROUTE_BASE + i * 32;
    const [pathOff, pathLen] = pack(r.path);
    const [ctOff, ctLen] = pack(r.ctype);
    const [bodyOff, bodyLen] = pack(r.body);
    lines.push(`  store32(${base + 0}, ${METHOD[r.method]})`);
    lines.push(`  store32(${base + 4}, ${pathOff})`);
    lines.push(`  store32(${base + 8}, ${pathLen})`);
    lines.push(`  store32(${base + 12}, ${r.status})`);
    lines.push(`  store32(${base + 16}, ${ctOff})`);
    lines.push(`  store32(${base + 20}, ${ctLen})`);
    lines.push(`  store32(${base + 24}, ${bodyOff})`);
    lines.push(`  store32(${base + 28}, ${bodyLen})`);
  });
  return `fn stage() -> Unit {\n${lines.join('\n')}\n  return ()\n}\n`;
}

// Build the benchmark source: the kernel with `main` rewritten to `serve_one`, plus stage() and a
// driver main that loops the hot path N times and prints the summed response length (a checksum that
// also proves the native artifact produced the same bytes-length as the oracle and Python).
function benchSrc(n) {
  const asServeOnce = KERNEL.replace('fn main(c: Console) -> Unit {', 'fn serve_one() -> Unit {');
  const driver = `${genStage()}
fn main(c: Console) -> Unit {
  stage()
  var acc = 0
  var i = 0
  while i < ${n} {
    serve_one()
    acc = acc + load32(829996)
    i = i + 1
  }
  c.print_int(acc)
  return ()
}
`;
  return `${asServeOnce}\n${driver}`;
}

function clangBuild(csrc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-serve-bench-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, cfile],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

function timeCmd(cmd, args, reps = 5) {
  let best = Infinity, out = '';
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    out = execFileSync(cmd, args, { encoding: 'utf8' });
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, out: out.trim() };
}

// Native side: build a binary per N, time each, throughput = (N2-N1) / (t2-t1) cancels startup.
async function nativeThroughput(n1, n2, expLen) {
  const r1 = await buildAndRunFn(benchSrc(n1), '-O2');
  const r2 = await buildAndRunFn(benchSrc(n2), '-O2');
  const a1 = r1.stdout.trim(), a2 = r2.stdout.trim();
  if (Number(a1) !== n1 * expLen || Number(a2) !== n2 * expLen) {
    throw new Error(`native checksum mismatch: got ${a1}/${a2}, want ${n1 * expLen}/${n2 * expLen}`);
  }
  const bin1 = clangBuild(r1.csrc), bin2 = clangBuild(r2.csrc);
  const t1 = timeCmd(bin1, []), t2 = timeCmd(bin2, []);
  return (n2 - n1) / ((t2.ms - t1.ms) / 1000);
}

function pyThroughput(n1, n2, expLen) {
  const t1 = timeCmd('python3', [PY, String(n1)]);
  const t2 = timeCmd('python3', [PY, String(n2)]);
  if (Number(t1.out) !== n1 * expLen || Number(t2.out) !== n2 * expLen) {
    throw new Error(`python checksum mismatch: got ${t1.out}/${t2.out}, want ${n1 * expLen}/${n2 * expLen}`);
  }
  return (n2 - n1) / ((t2.ms - t1.ms) / 1000);
}

function hasPython() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const doAssert = process.argv.includes('--assert');
const expLen = expectedResponseLen(REQUEST);
console.log('== Lumen-native HTTP/1.1 server vs Python (same algorithm, same bytes) ==');
console.log(`single response = ${expLen} bytes; request = ${JSON.stringify(REQUEST.split('\r\n')[0])}\n`);

const lumen = await nativeThroughput(200000, 2000000, expLen);
console.log(`Lumen (native, emit_fn -> clang -O2): ${(lumen / 1e6).toFixed(2)} M req/s`);

if (!hasPython()) {
  console.log('python3 not found - skipping the Python comparison (run locally to measure the ratio).');
  process.exit(0);
}
const py = pyThroughput(100000, 1000000, expLen);
console.log(`Python (CPython ${process.env.PYVER || '3'}, pure): ${(py / 1e6).toFixed(3)} M req/s`);
const ratio = lumen / py;
console.log(`\nLumen native is ${ratio.toFixed(1)}x Python on this workload.`);

if (doAssert && ratio < 1) {
  console.error(`FAIL: native throughput ${lumen.toFixed(0)} < Python ${py.toFixed(0)} req/s`);
  process.exit(1);
}
console.log(ratio >= 1 ? 'PASS: native Lumen beats Python.' : 'NOTE: Python faster on this run (see --assert).');
process.exit(0);
