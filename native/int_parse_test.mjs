// int_parse_test.mjs - oracle gate for the Lumen-native signed decimal integer parser.
//
// The parser (examples/http/int_parse.lm) is pure Lumen logic over a raw-memory byte buffer.
// This harness plays the role of the I/O seam: it writes a fixture's ASCII decimal digit
// bytes into the compiled program's memory at IN_BASE and the byte count at IN_LEN_ADDR, runs
// the program, and asserts the printed integer matches the expected value. Deterministic,
// offline.
//
// Because the parser adds no compiler feature (only load8/load32 + arithmetic), the language
// speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/int_parse.lm', import.meta.url), 'utf8');
const IN_BASE = 600000;
const IN_LEN_ADDR = 599996;

// Each case: [raw ascii digits, expected parsed integer]
const CASES = [
  ['12345', 12345],
  ['-42', -42],
  ['0', 0],
  ['1000000', 1000000],
];

async function parse(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`parser compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: IN_BASE (600000) and IN_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the input buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, IN_BASE);
  new DataView(I.ex.mem.buffer).setInt32(IN_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const lines = I.getOut().split('\n').filter(s => s.length > 0).map(Number);
  return lines[0];
}

let fail = 0;
console.log('== Lumen-native signed decimal integer parser (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await parse(raw);
  const ok = got === want;
  const label = JSON.stringify(raw);
  if (ok) { console.log(`PASS  ${label}  -> ${got}`); }
  else { console.log(`FAIL  ${label}  -> got ${got} want ${want}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} integers parsed correctly by the Lumen int parser.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
