// http_request_body_test.mjs - oracle gate for the Lumen-native HTTP request body extractor.
//
// The kernel (examples/http/http_request_body.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam that will later be a socket: it writes
// a fixture request's bytes into the compiled program's memory at REQ_BASE and the byte count at
// REQ_LEN_ADDR, runs the program, and asserts the emitted body bytes (at OUT_BASE, length at
// OUT_LEN_ADDR) match the expected body. Deterministic, offline.
//
// Because the kernel adds no compiler feature (only load8/store8 + arithmetic), the language
// speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_request_body.lm', import.meta.url), 'utf8');
const REQ_BASE = 600000;
const REQ_LEN_ADDR = 599996;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

// Each case: [raw request, expected body string]
const CASES = [
  ['POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello', 'hello'],
  ['GET / HTTP/1.1\r\n\r\n', ''],
  ['PUT /x HTTP/1.1\r\nA: b\r\n\r\ndata!', 'data!'],
];

async function extractBody(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`kernel compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: REQ_BASE (600000) and REQ_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the request buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, REQ_BASE);
  new DataView(I.ex.mem.buffer).setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = new DataView(I.ex.mem.buffer).getInt32(OUT_LEN_ADDR, true);
  const outBytes = new Uint8Array(I.ex.mem.buffer, OUT_BASE, outLen);
  return Buffer.from(outBytes).toString('latin1');
}

let fail = 0;
console.log('== Lumen-native HTTP request body extractor (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await extractBody(raw);
  const ok = got === want;
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got)}`); }
  else { console.log(`FAIL  ${label}  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} requests' bodies extracted correctly by the Lumen kernel.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
