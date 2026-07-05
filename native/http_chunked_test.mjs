// http_chunked_test.mjs - oracle gate for the Lumen-native HTTP chunked-transfer body decoder.
//
// The decoder (examples/http/http_chunked.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam that will later be a socket: it
// writes a fixture's chunked-encoded bytes into the compiled program's memory at IN_BASE and the
// byte count at IN_LEN_ADDR, runs the program, and asserts the decoded body bytes emitted at
// OUT_BASE (with length at OUT_LEN_ADDR) match the expected plaintext body.
//
// Because the decoder adds no compiler feature (only load8/store8/load32/store32 + arithmetic),
// the language speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_chunked.lm', import.meta.url), 'utf8');
const IN_BASE = 600000;
const IN_LEN_ADDR = 599996;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

// Each case: [chunked-encoded input, expected decoded body]
const CASES = [
  ['5\r\nhello\r\n0\r\n\r\n', 'hello'],
  ['1\r\nA\r\n2\r\nBC\r\n0\r\n\r\n', 'ABC'],
  ['0\r\n\r\n', ''],
];

async function decode(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`http_chunked compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: IN_BASE (600000) and IN_LEN_ADDR (599996) sit above page 9, which the
  // compile pass uses, so nothing clobbers the input buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  const mem8 = new Uint8Array(I.ex.mem.buffer);
  mem8.set(bytes, IN_BASE);
  new DataView(I.ex.mem.buffer).setInt32(IN_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = new DataView(I.ex.mem.buffer).getInt32(OUT_LEN_ADDR, true);
  const outBytes = Buffer.from(mem8.buffer, mem8.byteOffset + OUT_BASE, outLen);
  return Buffer.from(outBytes).toString('latin1');
}

let fail = 0;
console.log('== Lumen-native HTTP chunked-transfer body decoder (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await decode(raw);
  const ok = got === want;
  const label = JSON.stringify(raw);
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got)}`); }
  else { console.log(`FAIL  ${label}  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} chunked bodies decoded correctly by the Lumen HTTP decoder.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
