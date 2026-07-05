// http_parse_test.mjs - oracle gate for the Lumen-native HTTP/1.1 request parser.
//
// The parser (examples/http/parse_request.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam that will later be a socket: it
// writes a fixture request's bytes into the compiled program's memory at REQ_BASE and the byte
// count at REQ_LEN_ADDR, runs the program, and asserts the emitted parse (method / path offset
// / path length / HTTP version) matches the expected fields. Deterministic, offline.
//
// Because the parser adds no compiler feature (only load8 + arithmetic), the language speed is
// untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/parse_request.lm', import.meta.url), 'utf8');
const REQ_BASE = 600000;
const REQ_LEN_ADDR = 599996;

// Each case: [raw request, [method_code, path_offset, path_len, http_version]]
const CASES = [
  ['GET /home HTTP/1.1\r\nHost: fdv-quants.com\r\n\r\n', [1, 4, 5, 11]],
  ['POST /api/price HTTP/1.1\r\nContent-Length: 12\r\n\r\n', [2, 5, 10, 11]],
  ['DELETE /x HTTP/1.0\r\n\r\n', [4, 7, 2, 10]],
  ['PUT /a HTTP/1.1\r\n\r\n', [3, 4, 2, 11]],
  ['OPTIONS * HTTP/1.1\r\n\r\n', [7, 8, 1, 11]],
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
console.log('== Lumen-native HTTP/1.1 request parser (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await parse(raw);
  const ok = got.length === want.length && got.every((x, i) => x === want[i]);
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (ok) { console.log(`PASS  ${label}  -> [${got}]`); }
  else { console.log(`FAIL  ${label}  -> got [${got}] want [${want}]`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} requests parsed correctly by the Lumen HTTP parser.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
