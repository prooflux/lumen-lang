import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/hex_encode.lm', import.meta.url), 'utf8');

const FIXTURES = [
  { bytes: [65, 66], expected: "4142" },
  { bytes: [0, 255], expected: "00ff" },
  { bytes: [], expected: "" },
  { bytes: [16, 171, 5], expected: "10ab05" }
];

async function runTest() {
  let fail = 0;
  console.log('== Lumen-native hex_encode (oracle gate) ==');

  for (const { bytes, expected } of FIXTURES) {
    const I = await freshInstance();
    const len = writeSrc(I, SRC);
    I.ex.compile(len);
    if (I.ex.dbg_nerr() > 0) {
      throw new Error(`hex_encode compile: ${I.ex.dbg_nerr()} error(s)`);
    }

    const inputBytes = new Uint8Array(bytes);
    new Uint8Array(I.ex.mem.buffer).set(inputBytes, 600000);
    new DataView(I.ex.mem.buffer).setInt32(599996, bytes.length, true);

    I.ex.run(I.ex.dbg_main());

    const outLen = new DataView(I.ex.mem.buffer).getInt32(699996, true);
    const outBytes = new Uint8Array(I.ex.mem.buffer, 700000, outLen);
    const got = Buffer.from(outBytes).toString('utf8');

    const ok = got === expected;
    const label = `[${bytes.join(', ')}]`;
    if (ok) {
      console.log(`PASS  ${label}  -> "${got}"`);
    } else {
      console.log(`FAIL  ${label}  -> got "${got}" want "${expected}"`);
      fail++;
    }
  }

  console.log(fail === 0
    ? `\nAll fixtures passed.`
    : `\nFAIL: ${fail} fixtures failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
