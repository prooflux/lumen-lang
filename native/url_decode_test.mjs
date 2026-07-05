// url_decode_test.mjs - oracle gate for the Lumen-native URL percent-decoder.
//
// The decoder (examples/http/url_decode.lm) is pure Lumen protocol logic over raw-memory
// byte buffers. This harness plays the role of the I/O seam: it writes a fixture's input
// bytes into the compiled program's memory at IN_BASE and the byte count at IN_LEN_ADDR,
// runs the program, and reads back the decoded bytes from OUT_BASE using the decoded
// length stored at OUT_LEN_ADDR, then asserts it matches the expected decoded string.
//
// Because the decoder adds no compiler feature (only load8/store8/load32/store32 +
// arithmetic), the language speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/url_decode.lm', import.meta.url), 'utf8');
const IN_BASE = 600000;
const IN_LEN_ADDR = 599996;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

// Each case: [raw input, expected decoded string]
const CASES = [
  ['%2Fhome%20x', '/home x'],
  ['a+b%21', 'a b!'],
  ['plain', 'plain'],
];

async function decode(raw) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`decoder compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: IN_BASE (600000) and IN_LEN_ADDR (599996) sit above page 9, which
  // the compile pass uses, so nothing clobbers the input buffer at run time.
  const bytes = Buffer.from(raw, 'latin1');
  new Uint8Array(I.ex.mem.buffer).set(bytes, IN_BASE);
  new DataView(I.ex.mem.buffer).setInt32(IN_LEN_ADDR, bytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = new DataView(I.ex.mem.buffer).getInt32(OUT_LEN_ADDR, true);
  const outBytes = new Uint8Array(I.ex.mem.buffer).slice(OUT_BASE, OUT_BASE + outLen);
  return Buffer.from(outBytes).toString('latin1');
}

let fail = 0;
console.log('== Lumen-native URL percent-decoder (oracle gate) ==');
for (const [raw, want] of CASES) {
  const got = await decode(raw);
  const ok = got === want;
  const label = JSON.stringify(raw);
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got)}`); }
  else { console.log(`FAIL  ${label}  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} inputs decoded correctly by the Lumen URL decoder.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
