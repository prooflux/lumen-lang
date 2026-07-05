// http_status_line_test.mjs - oracle gate for the Lumen-native HTTP/1.1 status-line parser.
//
// The parser (examples/http/http_status_line.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam that will later be a socket: it writes
// a fixture response's bytes into the compiled program's memory at RES_BASE and the byte count at
// RES_LEN_ADDR, runs the program, and asserts the emitted status code matches the expected value.
// Deterministic, offline.
//
// Because the parser adds no compiler feature (only load8/load32 + arithmetic), the language speed
// is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_status_line.lm', import.meta.url), 'utf8');
const RES_BASE = 600000;
const RES_LEN_ADDR = 599996;

// Each case: [raw response, expected status code]
const CASES = [
  ['HTTP/1.1 200 OK\r\n\r\n', 200],
  ['HTTP/1.1 404 Not Found\r\n\r\n', 404],
  ['HTTP/1.1 500 Internal Server Error\r\n\r\n', 500],
];

async function parse(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`parser compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: RES_BASE (600000) and RES_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the response buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, RES_BASE);
  new DataView(I.ex.mem.buffer).setInt32(RES_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  return I.getOut().split('\n').filter(s => s.length > 0).map(Number);
}

let fail = 0;
console.log('== Lumen-native HTTP/1.1 status-line parser (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await parse(raw);
  const ok = got.length === 1 && got[0] === want;
  const label = JSON.stringify(raw.split('\r\n')[0]);
  if (ok) { console.log(`PASS  ${label}  -> ${got[0]}`); }
  else { console.log(`FAIL  ${label}  -> got [${got}] want ${want}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} status lines parsed correctly by the Lumen HTTP parser.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
