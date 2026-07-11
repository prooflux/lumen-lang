// native_handlers_test.mjs - gate for Stone A (handler routes): oracle bit-identity.
//
// The composed handler program (http_serve.lm's non-main logic + examples/http/handlers_demo.lm
// + a generated call_handler dispatcher + a generated main - see native/lumen_serve_native.mjs's
// genHandlerServeSrc) is run through BOTH the interpreter (freshInstance/writeSrc/compile, the
// correctness oracle) and the native serve binary (the length-framed stdin/stdout loop), for the
// same fixed set of requests, and their responses must be byte-identical.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { freshInstance, writeSrc } from './pipeline.mjs';
import { buildNativeServeHandlers } from './lumen_serve_native.mjs';

const HANDLERS_SRC = fs.readFileSync(new URL('../examples/http/handlers_demo.lm', import.meta.url), 'utf8');
const REQ_BASE = 590016, REQ_LEN_ADDR = 590000, OUT_LEN_ADDR = 7299996, OUT_BASE = 7300000, BODY_BASE = 1000000;

const ROUTES = [
  { method: 'GET', path: '/', status: 200, contentType: 'text/plain', body: 'hi' },
  { method: 'GET', path: '/echo', status: 200, contentType: 'text/plain', handler: 'echo' },
  { method: 'GET', path: '/bs', status: 200, contentType: 'application/json', handler: 'bs' },
].map((r) => ({ ...r, bodyBytes: r.body ? Buffer.from(r.body, 'utf8') : undefined }));

// Requests exercised by the oracle gate: echo w/ query, echo w/o query, bs (canonical case), a
// static route, and an unmatched route (proxy mode on -> expect an empty response).
const REQUESTS = [
  'GET /echo?hello=world HTTP/1.1\r\nHost: x\r\n\r\n',
  'GET /echo HTTP/1.1\r\nHost: x\r\n\r\n',
  'GET /bs?s=100&k=100&v=20&t=100&r=5 HTTP/1.1\r\n\r\n',
  'GET / HTTP/1.1\r\n\r\n',
  'GET /not-a-route HTTP/1.1\r\n\r\n',
];

let fail = 0;

console.log('== Stone A: handler routes, interpreter oracle vs native serve binary (bit-identical) ==');

const { bin, bodyBlock, src } = await buildNativeServeHandlers(ROUTES, true, HANDLERS_SRC);   // proxyMode=true
console.log(`built ${bin}`);

// interpreter side: one instance, staged once (the composed main self-stages on STAGED_ADDR==0),
// exactly like http_serve_test.mjs stages once and serves many requests.
const I = await freshInstance();
{
  const len = writeSrc(I, src);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`composed handler program compile: ${I.ex.dbg_nerr()} error(s)`);
}
new Uint8Array(I.ex.mem.buffer).set(bodyBlock, BODY_BASE);   // the host's startup body-streaming step

function serveInterp(raw) {
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, REQ_BASE);
  const dv = new DataView(I.ex.mem.buffer);
  dv.setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.ex.run(I.ex.dbg_main());
  const outLen = dv.getInt32(OUT_LEN_ADDR, true);
  return Buffer.from(I.ex.mem.buffer, OUT_BASE, outLen).toString('latin1');
}

// native side: spawn once, drive the framed pipe FIFO (same protocol lumen_serve_native.mjs's
// makeServer uses).
function frame(bytes) {
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
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.stdin.write(frame(preload));
  return {
    send: (reqBytes) => new Promise((resolve) => {
      child.stdin.write(frame(reqBytes));
      pending.push(resolve);
    }),
    isAlive: () => exited === null,
    exited: () => exited,
    kill: () => child.kill(),
  };
}

const driver = makeDriver(bin, bodyBlock);

let checks = 0;
for (const raw of REQUESTS) {
  checks++;
  const want = serveInterp(raw);
  const got = (await driver.send(Buffer.from(raw, 'latin1'))).toString('latin1');
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (got === want) {
    console.log(`PASS  ${label} -> bit-identical (${want.length} bytes${want.length === 0 ? ', empty: proxy' : ''})`);
  } else {
    console.log(`FAIL  ${label}`);
    const n = Math.min(got.length, want.length);
    let i = 0;
    while (i < n && got[i] === want[i]) i++;
    console.log(`  diverge at byte ${i} (interp len ${want.length}, native len ${got.length})`);
    console.log(`  interp context: ${JSON.stringify(want.slice(Math.max(0, i - 30), i + 30))}`);
    console.log(`  native context: ${JSON.stringify(got.slice(Math.max(0, i - 30), i + 30))}`);
    fail++;
  }
}
console.log(fail === 0 ? `\n${checks}/${checks} handler-route responses bit-identical (interpreter vs native).`
  : `\nFAIL: ${fail}/${checks} handler-route responses diverged.`);

driver.kill();

console.log(`\nSummary: ${checks - fail} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
