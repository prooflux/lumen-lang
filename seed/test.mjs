// Lumen-mu compiler conformance runner: compile each source -> IR -> run, check stdout.
// Usage: node test.mjs
import fs from 'node:fs';
import wabtInit from 'wabt';

const SRC_BASE = 100000;
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
  ['../mu/examples/count.lm', '1\n2\n3\n4\n5\n'],
  ['../mu/examples/sum_loop.lm', '55\n'],
  ['../mu/examples/bitwise.lm', '8\n14\n6\n16\n16\n-1\n'],
  ['../mu/examples/safe_div.lm', 'ok 4\ndiv by zero\n'],
  ['../mu/examples/propagate.lm', '9\n'],
  ['../mu/examples/bools.lm', '1\n0\n1\n0\n1\n1\n1\n1\n42\n3\n'],
  ['../mu/examples/arrays.lm', '3\n15000\n45000\n2\n84388\n'],
  ['../mu/examples/records.lm', '7\n4\n15000\n22500\n5\n40000\n'],
  ['../mu/examples/floats.lm', '15000\n2500\n60000\n6000\n104506\n3989\n-15000\n-3\n1\n7\n2\n2\n12247\n15000\n44817\n4055\n22500\n'],
  ['native/test_load32.lm', '7\n65\n'],   // raw-memory keystone: store32/load32 + store8/load8 round-trip
  ['../examples/black_scholes.lm', 'bs_call=10.450576\n'],
  ['../examples/finance/black_scholes.lm', '104506\n\n60401\n\n154860\n\n79020\n\n'],   // the certified pricing table, scaled x10000
  ['../examples/finance/implied_vol.lm', '2000\n\n2000\n\n'],   // recovers sigma=20.00% (x100 scale) from both market prices   // quant oracle: reproduces the canonical Black-Scholes call (10.450584) to 8e-6; also exercises userland float_to_text
  ['../examples/finance/bond_price.lm', '1027751\n\n1043295\n\n10194156\n\n822702\n\n'],   // fixed-rate bond pricer: discounts cashflows with repeated-multiply, scaled x10000
  ['../examples/finance/bump_greeks.lm', '104506\n\n6368\n\n18763\n\n375239\n\n'],   // bump-Greeks finite-difference kernel: delta/gamma/vega via central diff on BS pricer, scaled by 10000/1000000/10000
  ['../examples/finance/swap_rate.lm', '839457\n\n45647\n\n30249\n\n35171\n\n'],   // par interest-rate swap kernel: discount factors and annuity, scaled x1000000/10000/1000000
  ['../examples/finance/vol_surface_heston.lm', 'K70_T025=216972279389\nK100_T10=210276489335\nK130_T20=207265613578\nK85_T05=214200288766\n'],   // Heston IV surface (Lewis/Gatheral approx): 4 canonical grid points, IV scaled x1e12, matches the shipped beta-app volatility_surface.js oracle to 12 sig digits
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
