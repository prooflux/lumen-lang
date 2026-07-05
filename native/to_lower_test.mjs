// to_lower_test.mjs - oracle gate for the Lumen-native ASCII-lowercasing kernel.
//
// The kernel (examples/http/to_lower.lm) is pure Lumen logic over a raw-memory byte
// buffer. This harness writes a fixture's input bytes into the compiled program's memory
// at IN_BASE and the byte count at IN_LEN_ADDR, runs the program, and asserts the emitted
// output bytes (at OUT_BASE, length at OUT_LEN_ADDR) match the expected lowercased bytes.
// Deterministic, offline.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/to_lower.lm', import.meta.url), 'utf8');
const IN_BASE = 600000;
const IN_LEN_ADDR = 599996;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

// Each case: [input, expected output]
const CASES = [
  ['Hello, World', 'hello, world'],
  ['ABC123xyz', 'abc123xyz'],
  ['', ''],
];

async function toLower(input) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`kernel compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: IN_BASE/OUT_BASE sit above page 9, which the compile pass uses,
  // so nothing clobbers the buffers at run time.
  const bytes = Buffer.from(input, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, IN_BASE);
  new DataView(I.ex.mem.buffer).setInt32(IN_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = new DataView(I.ex.mem.buffer).getInt32(OUT_LEN_ADDR, true);
  const outBytes = new Uint8Array(I.ex.mem.buffer, OUT_BASE, outLen);
  return Buffer.from(outBytes).toString('latin1');
}

let fail = 0;
console.log('== Lumen-native ASCII to_lower kernel (oracle gate) ==');
for (const [input, want] of CASES) {
  const got = await toLower(input);
  const ok = got === want;
  const label = JSON.stringify(input);
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got)}`); }
  else { console.log(`FAIL  ${label}  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} inputs lowercased correctly by the Lumen kernel.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
