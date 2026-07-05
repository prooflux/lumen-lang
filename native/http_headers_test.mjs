// http_headers_test.mjs - oracle gate for the Lumen-native HTTP header parser.
//
// The parser (examples/http/http_headers.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam that will later be a socket: it
// writes a fixture request's bytes into the compiled program's memory at REQ_BASE and the byte
// count at REQ_LEN_ADDR, runs the program, and asserts the emitted header count and
// Content-Length value match expectations. Deterministic, offline.
//
// Because the parser adds no compiler feature (only load8/load32 + arithmetic), the language
// speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_headers.lm', import.meta.url), 'utf8');
const REQ_BASE = 600000;
const REQ_LEN_ADDR = 599996;

// Each case: [raw request, [header_count, content_length]]
const CASES = [
  ['GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 42\r\nX: y\r\n\r\n', [3, 42]],
  ['GET / HTTP/1.1\r\n\r\n', [0, -1]],
  ['GET / HTTP/1.1\r\ncontent-length: 7\r\n\r\n', [1, 7]],
];

async function parse(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`parser compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: REQ_BASE (600000) and REQ_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the request buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, REQ_BASE);
  new DataView(I.ex.mem.buffer).setInt32(REQ_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  return I.getOut().split('\n').filter(s => s.length > 0).map(Number);
}

let fail = 0;
console.log('== Lumen-native HTTP header parser (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await parse(raw);
  const ok = got.length === want.length && got.every((x, i) => x === want[i]);
  const label = JSON.stringify(raw);
  if (ok) { console.log(`PASS  ${label}  -> [${got}]`); }
  else { console.log(`FAIL  ${label}  -> got [${got}] want [${want}]`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} requests parsed correctly by the Lumen HTTP header parser.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
