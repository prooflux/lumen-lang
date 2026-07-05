// http_response_test.mjs - oracle gate for the Lumen-native HTTP/1.1 response builder.
//
// The builder (examples/http/http_response.lm) is pure Lumen protocol logic over raw-memory
// byte buffers. This harness plays the role of the I/O seam: it writes a fixture's status code
// and body bytes into the compiled program's memory at CODE_ADDR / BODY_BASE / BODY_LEN_ADDR,
// runs the program, and asserts the emitted response bytes (read back from OUT_BASE, with the
// length at OUT_LEN_ADDR) match the expected HTTP/1.1 response string exactly.
//
// Because the builder adds no compiler feature (only load8/store8/load32/store32 + arithmetic),
// the language speed is untouched; perf.mjs remains the throughput gate.
import fs from 'node:fs';
import { freshInstance, writeSrc } from './pipeline.mjs';

const SRC = fs.readFileSync(new URL('../examples/http/http_response.lm', import.meta.url), 'utf8');
const CODE_ADDR = 599992;
const BODY_LEN_ADDR = 599996;
const BODY_BASE = 600000;
const OUT_BASE = 700000;
const OUT_LEN_ADDR = 699996;

// Each case: [status code, body string, expected full response string]
const CASES = [
  [200, 'OK', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK'],
  [404, '', 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'],
  [500, 'err', 'HTTP/1.1 500 Internal Server Error\r\nContent-Length: 3\r\n\r\nerr'],
];

async function build(code, body) {
  const I = await freshInstance();
  const len = writeSrc(I, SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`http_response compile: ${I.ex.dbg_nerr()} error(s)`);
  // Inject AFTER compile: CODE_ADDR / BODY_LEN_ADDR / BODY_BASE / OUT_BASE / OUT_LEN_ADDR all sit
  // above the pages the compile pass uses, so nothing clobbers them at run time.
  const bodyBytes = Buffer.from(body, 'latin1');
  const mem = I.ex.mem;
  new Uint8Array(mem.buffer).set(bodyBytes, BODY_BASE);
  const dv = new DataView(mem.buffer);
  dv.setInt32(CODE_ADDR, code, true);
  dv.setInt32(BODY_LEN_ADDR, bodyBytes.length, true);
  I.resetOut();
  I.ex.run(I.ex.dbg_main());
  const outLen = dv.getInt32(OUT_LEN_ADDR, true);
  const outBytes = Buffer.from(mem.buffer, OUT_BASE, outLen);
  return outBytes.toString('latin1');
}

let fail = 0;
console.log('== Lumen-native HTTP/1.1 response builder (oracle gate) ==');
for (const [code, body, want] of CASES) {
  const got = await build(code, body);
  const ok = got === want;
  const label = `${code} body=${JSON.stringify(body)}`;
  if (ok) { console.log(`PASS  ${label}  -> ${JSON.stringify(got)}`); }
  else { console.log(`FAIL  ${label}  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
}
console.log(fail === 0
  ? `\n${CASES.length}/${CASES.length} responses built correctly by the Lumen HTTP response builder.`
  : `\nFAIL: ${fail}/${CASES.length} cases failed.`);
process.exit(fail === 0 ? 0 : 1);
