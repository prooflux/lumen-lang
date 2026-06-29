// Lumen-mu compiler conformance runner: compile each source -> IR -> run, check stdout.
// Usage: node test.mjs
import fs from 'node:fs';
import wabtInit from 'wabt';

const SRC_BASE = 20000;
const cases = [
  ['../mu/examples/fib_print.lm', '55\n'],
  ['../mu/examples/add.lm', '42\n'],
  ['../mu/examples/max.lm', '13\n'],
  ['../mu/examples/fact.lm', '120\n'],
  ['../mu/examples/locals.lm', '31\n'],
  ['../mu/examples/forward.lm', '42\n'],
  ['../mu/examples/mutual.lm', '1\n'],
  ['../mu/examples/hello.lm', 'hello, world\n'],
  ['../mu/examples/greet.lm', 'hi there\n'],
  ['../mu/examples/report.lm', 'fib(10) = 55\n'],
  ['../mu/examples/compare.lm', '100\n50\n1\n'],
  ['../mu/examples/gcd.lm', '12\n'],
  ['../mu/examples/fizzbuzz.lm', '1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz\n'],
];

const wabt = await wabtInit();
const wat = fs.readFileSync(new URL('./lumenc.wat', import.meta.url), 'utf8');
const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;

async function runOne(relPath) {
  const source = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  const b = Buffer.from(source, 'utf8');
  new Uint8Array(instance.exports.mem.buffer, SRC_BASE, b.length).set(b);
  instance.exports.compile_and_run(b.length);
  return { out, ir: instance.exports.dbg_emit() };
}

let pass = 0;
for (const [path, expected] of cases) {
  const { out, ir } = await runOne(path);
  const ok = out === expected;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${path.replace('../mu/examples/', '')}  -> ${JSON.stringify(out)}  (expected ${JSON.stringify(expected)}, ir_words=${ir})`);
}
console.log(`\n${pass}/${cases.length} Lumen-mu programs compiled from source and ran correctly.`);
process.exit(pass === cases.length ? 0 : 1);
