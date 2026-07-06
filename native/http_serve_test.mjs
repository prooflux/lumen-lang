// http_serve_test.mjs - oracle gate for the Lumen-native table-driven HTTP/1.1 server kernel.
//
// The kernel (examples/http/http_serve.lm) is pure Lumen protocol logic: given a raw request and a
// route table (both staged in raw memory), it produces the exact response bytes. This harness plays
// the role of the socket seam it will later sit behind: it stages a fixture route table once, then
// for each fixture request writes the bytes into memory, runs the kernel, and asserts the response
// bytes (read back from OUT_BASE / OUT_LEN_ADDR) match the expected HTTP/1.1 response exactly.
//
// Because the kernel adds no compiler feature (only load/store + arithmetic), language speed is
// untouched; perf.mjs remains the throughput gate, and http_serve_bench.mjs measures the native
// artifact against a scripting-language baseline.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_serve.lm', import.meta.url), 'utf8');

// Memory map - must match examples/http/http_serve.lm exactly.
const REQ_LEN_ADDR = 590000;
const REQ_BASE = 590016;
const ROUTE_COUNT_ADDR = 598000;
const PROXY_MODE_ADDR = 598008;
const ROUTE_BASE = 598016;
const BLOB_BASE = 604000;
const OUT_LEN_ADDR = 829996;
const OUT_BASE = 830000;

const METHOD = { GET: 1, POST: 2, PUT: 3, DELETE: 4, HEAD: 5, PATCH: 6, OPTIONS: 7 };

// The fixture route table. Each route: method, path, status, content-type, body.
const ROUTES = [
  { method: 'GET', path: '/', status: 200, ctype: 'text/plain', body: 'hi' },
  { method: 'GET', path: '/health', status: 200, ctype: 'text/plain', body: 'ok' },
  { method: 'GET', path: '/home', status: 200, ctype: 'text/html; charset=utf-8', body: '<h1>Home</h1>' },
  { method: 'POST', path: '/api', status: 200, ctype: 'application/json', body: '{}' },
];

// Build the expected full response string for a matched route (or the 404 fallback).
function expectResponse(status, reason, ctype, body) {
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${ctype}\r\n` +
    `Content-Length: ${Buffer.byteLength(body, 'latin1')}\r\nConnection: close\r\n\r\n${body}`;
}

// Each case: [raw request, expected full response string]
const NOT_FOUND = expectResponse(404, 'Not Found', 'text/plain', 'Not Found');
const CASES = [
  ['GET / HTTP/1.1\r\nHost: x\r\n\r\n', expectResponse(200, 'OK', 'text/plain', 'hi')],
  ['GET /health HTTP/1.1\r\n\r\n', expectResponse(200, 'OK', 'text/plain', 'ok')],
  ['GET /home HTTP/1.1\r\nHost: example\r\n\r\n', expectResponse(200, 'OK', 'text/html; charset=utf-8', '<h1>Home</h1>')],
  ['POST /api HTTP/1.1\r\nContent-Length: 0\r\n\r\n', expectResponse(200, 'OK', 'application/json', '{}')],
  ['GET /missing HTTP/1.1\r\n\r\n', NOT_FOUND],            // unknown path
  ['DELETE / HTTP/1.1\r\n\r\n', NOT_FOUND],                // method mismatch on a known path
  ['POST / HTTP/1.1\r\n\r\n', NOT_FOUND],                  // method mismatch, POST vs GET "/"
];

// Stage the route table + blob into the instance's memory once (the host's startup step).
function stageRoutes(mem, routes) {
  const u8 = new Uint8Array(mem.buffer);
  const dv = new DataView(mem.buffer);
  let blob = BLOB_BASE;
  const packStr = (s) => {
    const bytes = Buffer.from(s, 'latin1');
    const off = blob;
    u8.set(bytes, off);
    blob += bytes.length;
    return [off, bytes.length];
  };
  dv.setInt32(ROUTE_COUNT_ADDR, routes.length, true);
  routes.forEach((r, i) => {
    const base = ROUTE_BASE + i * 32;
    const [pathOff, pathLen] = packStr(r.path);
    const [ctOff, ctLen] = packStr(r.ctype);
    const [bodyOff, bodyLen] = packStr(r.body);
    dv.setInt32(base + 0, METHOD[r.method], true);
    dv.setInt32(base + 4, pathOff, true);
    dv.setInt32(base + 8, pathLen, true);
    dv.setInt32(base + 12, r.status, true);
    dv.setInt32(base + 16, ctOff, true);
    dv.setInt32(base + 20, ctLen, true);
    dv.setInt32(base + 24, bodyOff, true);
    dv.setInt32(base + 28, bodyLen, true);
  });
}

const I = await freshInstance();
const len = writeSrc(I, SRC);
I.ex.compile(len);
if (I.ex.dbg_nerr() > 0) throw new Error(`http_serve compile: ${I.ex.dbg_nerr()} error(s)`);
const mem = I.ex.mem;
stageRoutes(mem, ROUTES);   // staged once, like a real server's startup

function serve(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(mem.buffer).set(bytes, REQ_BASE);
  const dv = new DataView(mem.buffer);
  dv.setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.ex.run(I.ex.dbg_main());
  const outLen = dv.getInt32(OUT_LEN_ADDR, true);
  return Buffer.from(mem.buffer, OUT_BASE, outLen).toString('latin1');
}

let fail = 0;
let checks = 0;
console.log('== Lumen-native table-driven HTTP/1.1 server (oracle gate) ==');
for (const [raw, want] of CASES) {
  checks++;
  const got = serve(raw);
  const ok = got === want;
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got.split('\r\n')[0])} (${Buffer.byteLength(got, 'latin1')} bytes)`); }
  else { console.log(`FAIL  ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++; }
}

// Proxy mode: with PROXY_MODE=1, an unmatched request emits an empty response (out length 0) so the
// host proxies it to an origin; a matched route is still served locally. Default (0) stays 404.
const pdv = new DataView(mem.buffer);
pdv.setInt32(PROXY_MODE_ADDR, 1, true);
{
  checks++;
  const bytes = Buffer.from('GET /a-legacy-route HTTP/1.1\r\n\r\n', 'latin1');
  new Uint8Array(mem.buffer).set(bytes, REQ_BASE);
  pdv.setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.ex.run(I.ex.dbg_main());
  const outLen = pdv.getInt32(OUT_LEN_ADDR, true);
  if (outLen === 0) { console.log('PASS  proxy-mode unmatched  -> empty (host proxies to origin)'); }
  else { console.log(`FAIL  proxy-mode unmatched  -> outLen ${outLen}, want 0`); fail++; }
}
{
  checks++;
  const want = expectResponse(200, 'OK', 'text/html; charset=utf-8', '<h1>Home</h1>');
  const got = serve('GET /home HTTP/1.1\r\n\r\n');
  if (got === want) { console.log('PASS  proxy-mode matched /home -> served locally by the kernel'); }
  else { console.log(`FAIL  proxy-mode matched /home\n  got ${JSON.stringify(got)}`); fail++; }
}
pdv.setInt32(PROXY_MODE_ADDR, 0, true);

console.log(fail === 0
  ? `\n${checks}/${checks} server checks passed (routing, 404, and proxy-mode fallback).`
  : `\nFAIL: ${fail}/${checks} checks failed.`);
process.exit(fail === 0 ? 0 : 1);
