// tenant_routing_test.mjs - gate for Stone D (host-keyed multi-tenant routing): ONE compiled
// program (interpreter oracle AND native serve binary) fronting MULTIPLE tenant hostnames, plus a
// wildcard route that matches any host, plus a handler route bound to one specific tenant.
//
// This is the density lever: a config's routes each carry an OPTIONAL `host` field. A route with
// no host is a wildcard (matches ANY request, the pre-existing single-tenant behavior - see
// http_serve_test.mjs, which never sets a host and must stay byte-identical). A route WITH a host
// only matches requests whose "Host: " header value equals it exactly. First match wins, so
// tenant-specific routes are staged ahead of the wildcard ones.
//
// The oracle discipline is the same as native_handlers_test.mjs: build ONE composed program via
// buildNativeServeHandlers (handlersSrc is examples/http/handlers_demo.lm, reused verbatim for the
// host-bound handler case), run it through both the interpreter and the native binary for the same
// fixed request set, and assert every response is bit-identical.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { freshInstance, writeSrc } from './pipeline.mjs';
import { buildNativeServeHandlers } from './lumen_serve_native.mjs';

const HANDLERS_SRC = fs.readFileSync(new URL('../examples/http/handlers_demo.lm', import.meta.url), 'utf8');
const REQ_BASE = 590016, REQ_LEN_ADDR = 590000, OUT_LEN_ADDR = 7299996, OUT_BASE = 7300000, BODY_BASE = 1000000;

// Two tenants (a.example.com, b.example.com) each get their own /home body. /health is a wildcard
// (no host: any tenant, or no Host header at all, hits it). /echo is a handler route bound ONLY to
// tenant a - proves the host gate applies to handler routes exactly like static-body routes.
const ROUTES = [
  { method: 'GET', path: '/home', host: 'a.example.com', status: 200, contentType: 'text/plain', body: 'AAA' },
  { method: 'GET', path: '/home', host: 'b.example.com', status: 200, contentType: 'text/plain', body: 'BBB' },
  { method: 'GET', path: '/echo', host: 'a.example.com', status: 200, contentType: 'text/plain', handler: 'echo' },
  { method: 'GET', path: '/health', status: 200, contentType: 'text/plain', body: 'ok' },
].map((r) => ({ ...r, bodyBytes: r.body ? Buffer.from(r.body, 'utf8') : undefined }));

function expectResponse(status, reason, ctype, body) {
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${ctype}\r\n` +
    `Content-Length: ${Buffer.byteLength(body, 'latin1')}\r\nConnection: keep-alive\r\n\r\n${body}`;
}
const NOT_FOUND = expectResponse(404, 'Not Found', 'text/plain', 'Not Found');

// Each case: [label, raw request, expected full response string]
const CASES = [
  ['tenant a /home', 'GET /home HTTP/1.1\r\nHost: a.example.com\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'AAA')],
  ['tenant b /home', 'GET /home HTTP/1.1\r\nHost: b.example.com\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'BBB')],
  ['unknown tenant /home', 'GET /home HTTP/1.1\r\nHost: c.example.com\r\n\r\n', NOT_FOUND],
  ['no Host header /home', 'GET /home HTTP/1.1\r\n\r\n', NOT_FOUND],
  ['wildcard /health, tenant a host', 'GET /health HTTP/1.1\r\nHost: a.example.com\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'ok')],
  ['wildcard /health, tenant b host', 'GET /health HTTP/1.1\r\nHost: b.example.com\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'ok')],
  ['wildcard /health, unknown host', 'GET /health HTTP/1.1\r\nHost: anything.at.all\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'ok')],
  ['wildcard /health, no Host header', 'GET /health HTTP/1.1\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'ok')],
  ['host-bound handler, correct tenant', 'GET /echo?hi=there HTTP/1.1\r\nHost: a.example.com\r\n\r\n',
    expectResponse(200, 'OK', 'text/plain', 'hi=there')],
  ['host-bound handler, wrong tenant', 'GET /echo?hi=there HTTP/1.1\r\nHost: b.example.com\r\n\r\n', NOT_FOUND],
];

let fail = 0, checks = 0;
console.log('== Host-keyed multi-tenant routing (Stone D) - oracle gate ==');

const { bin, bodyBlock, src } = await buildNativeServeHandlers(ROUTES, false, HANDLERS_SRC);   // proxyMode=false: expect real 404s
console.log(`built ${bin}`);

// interpreter oracle: one instance, staged once (the composed main self-stages), same discipline
// as http_serve_test.mjs / native_handlers_test.mjs.
const I = await freshInstance();
{
  const len = writeSrc(I, src);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`composed tenant-routing program compile: ${I.ex.dbg_nerr()} error(s)`);
}
new Uint8Array(I.ex.mem.buffer).set(bodyBlock, BODY_BASE);

function serveInterp(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, REQ_BASE);
  const dv = new DataView(I.ex.mem.buffer);
  dv.setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.ex.run(I.ex.dbg_main());
  const outLen = dv.getInt32(OUT_LEN_ADDR, true);
  return Buffer.from(I.ex.mem.buffer, OUT_BASE, outLen).toString('latin1');
}

// native side: one long-lived process, driven over the length-framed pipe.
function frameMsg(bytes) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(bytes.length);
  return Buffer.concat([h, bytes]);
}

function makeDriver(binPath, preload) {
  const child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = [];
  let acc = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= 4) {
      const len = acc.readUInt32LE(0);
      if (acc.length < 4 + len) break;
      const resp = acc.subarray(4, 4 + len);
      acc = acc.subarray(4 + len);
      pending.shift()?.(Buffer.from(resp));
    }
  });
  child.stdin.write(frameMsg(preload));
  return {
    send: (reqBytes) => new Promise((resolve) => {
      child.stdin.write(frameMsg(reqBytes));
      pending.push(resolve);
    }),
    kill: () => child.kill(),
  };
}

const driver = makeDriver(bin, bodyBlock);

for (const [label, raw, want] of CASES) {
  checks++;
  const gotInterp = serveInterp(raw);
  const gotNative = (await driver.send(Buffer.from(raw, 'latin1'))).toString('latin1');
  const interpOk = gotInterp === want;
  const nativeOk = gotNative === want;
  const identOk = gotInterp === gotNative;
  if (interpOk && nativeOk && identOk) {
    console.log(`PASS  ${label} -> bit-identical (${want.length} bytes)`);
  } else {
    console.log(`FAIL  ${label}`);
    if (!interpOk) console.log(`  interp mismatch: got ${JSON.stringify(gotInterp)}\n              want ${JSON.stringify(want)}`);
    if (!nativeOk) console.log(`  native mismatch: got ${JSON.stringify(gotNative)}\n              want ${JSON.stringify(want)}`);
    if (interpOk && nativeOk && !identOk) console.log('  interp and native both matched want but diverged from each other (unreachable)');
    fail++;
  }
}

driver.kill();

console.log(fail === 0
  ? `\n${checks}/${checks} tenant-routing checks passed (host match, wildcard fallback, host-bound handler).`
  : `\nFAIL: ${fail}/${checks} checks failed.`);
process.exit(fail === 0 ? 0 : 1);
