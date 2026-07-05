// query_parse_test.mjs - oracle gate for the Lumen-native URL query-string pair counter.
//
// The kernel (examples/http/query_parse.lm) is pure Lumen protocol logic over a raw-memory
// byte buffer. This harness plays the role of the I/O seam: it writes a fixture query string's
// bytes into the compiled program's memory at QS_BASE and the byte count at QS_LEN_ADDR, runs
// the program, and asserts the emitted pair count matches the expected value. Deterministic,
// offline.
//
// Because the kernel adds no compiler feature (only load8/load32 + arithmetic), the language
// speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/query_parse.lm', import.meta.url), 'utf8');
const QS_BASE = 600000;
const QS_LEN_ADDR = 599996;

// Each case: [query string, expected pair count]
const CASES = [
  ['a=1&b=2&c=3', 3],
  ['', 0],
  ['x=1', 1],
  ['k=', 1],
];

async function parse(qs) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`kernel compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: QS_BASE (600000) and QS_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the query buffer at run time.
  const bytes = Buffer.from(qs, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, QS_BASE);
  new DataView(I.ex.mem.buffer).setInt32(QS_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  return I.getOut().split('\n').filter(s => s.length > 0).map(Number);
}

let fail = 0;
console.log('== Lumen-native URL query-string pair counter (oracle gate) ==');
for (const [qs, want] of CASES) {
  const got = await parse(qs);
  const ok = got.length === 1 && got[0] === want;
  const label = JSON.stringify(qs);
  if (ok) { console.log(`PASS  ${label}  -> [${got}]`); }
  else { console.log(`FAIL  ${label}  -> got [${got}] want [${want}]`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} query strings counted correctly by the Lumen query parser.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
