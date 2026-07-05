import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/hex_decode.lm', import.meta.url), 'utf8');
const IN_BASE = 600000;
const IN_LEN_ADDR = 599996;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

const CASES = [
  ['4142', [65, 66]],
  ['00ff', [0, 255]],
  ['', []],
  ['10AB05', [16, 171, 5]],
];

async function runCase(hexStr) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`compile failed: ${I.ex.dbg_nerr()} error(s)`);

  const bytes = Buffer.from(hexStr, 'ascii');
  new Uint8Array(I.ex.mem.buffer).set(bytes, IN_BASE);
  new DataView(I.ex.mem.buffer).setInt32(IN_LEN_ADDR, bytes.length, true);

  I.resetOut();
  I.ex.run(I.ex.dbg_main());

  const outLen = new DataView(I.ex.mem.buffer).getInt32(OUT_LEN_ADDR, true);
  const outBytes = new Uint8Array(I.ex.mem.buffer).slice(OUT_BASE, OUT_BASE + outLen);
  return Array.from(outBytes);
}

let fail = 0;
console.log('== Lumen-native hex decoder (oracle gate) ==');
for (const [hexStr, want] of CASES) {
  const got = await runCase(hexStr);
  const ok = got.length === want.length && got.every((x, i) => x === want[i]);
  if (ok) {
    console.log(`PASS  "${hexStr}" -> [${got}]`);
  } else {
    console.log(`FAIL  "${hexStr}" -> got [${got}] want [${want}]`);
    fail++;
  }
}

console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} cases passed.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
