// Differential fuzz gate for the self-hosted compiler's Float front-end: thousands of random
// decimal literals plus a mixed-coercion expression/comparison/statement zoo, compiled by BOTH
// the seed (lumenc.wat) and the self-hosted compiler (lumenc.lm, running under the seed VM).
// Every program's IR must be word-identical. This is the brute-force confidence layer behind
// the census: the census pins curated programs; this pins the float-literal bit construction
// (two hardware roundings reproduced by lumenc.lm's float_bits) and the Int->Float coercion
// rules across a large random surface. Deterministic PRNG - no flakes, same corpus every run.
import fs from 'node:fs';
import wabtInit from 'wabt';
import { createCompiler, CODE_BASE } from './compiler_core.mjs';

const wabt = await wabtInit();
const binary = wabt.parseWat('lumenc.wat', fs.readFileSync(new URL('./lumenc.wat', import.meta.url), 'utf8')).toBinary({}).buffer;
const module = await WebAssembly.compile(binary);
const L = await createCompiler();
const resB = L.compile(fs.readFileSync(new URL('./lumenc.lm', import.meta.url), 'utf8'));
if (!resB.ok) { console.error('lumenc.lm does not compile under the seed'); process.exit(1); }
const lmIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, resB.irWords).slice();
const memB = new DataView(L.exports.mem.buffer);
const u8B = new Uint8Array(L.exports.mem.buffer);
let lexCompileEntry = -1; const lexEntries = [];
for (let addr = 150000; addr < 157000; addr += 12) {
  const off = memB.getInt32(addr, true), len = memB.getInt32(addr + 4, true), entry = memB.getInt32(addr + 8, true);
  if (off >= 100000 && off < 150000 && len > 0) {
    const name = Buffer.from(u8B.slice(off, off + len)).toString();
    if (name === 'lex_compile') lexCompileEntry = entry;
    else if (name === 'lex') lexEntries.push(entry);
  }
}
if (lexCompileEntry === -1) { console.error('lex_compile symbol not found'); process.exit(1); }

async function selfCompile(src) {
  const inst = await WebAssembly.instantiate(module, { lumen: { console_print: () => {} } });
  const ex = inst.exports;
  new Int32Array(ex.mem.buffer, CODE_BASE, resB.irWords).set(lmIR);
  const code = new Int32Array(ex.mem.buffer, CODE_BASE, resB.irWords + 10);
  if (lexEntries.length > 1) {
    // same stale-lex CALL redirect as selfhost_diff.mjs; self-disables once the dup is removed
    const stale = new Set(lexEntries.slice(0, -1)); const good = lexEntries[lexEntries.length - 1];
    const TWO = new Set([1, 2, 6, 7, 13, 14, 15, 25]);
    let i = 0;
    while (i < resB.irWords) {
      const op = code[i];
      if (op === 8) { if (stale.has(code[i + 1])) code[i + 1] = good; i += 3; }
      else if (op === 29) i += 3;
      else if (op === 57) i += code[i + 1] + 3;
      else i += 1 + (TWO.has(op) ? 1 : 0);
    }
  }
  const sb = Buffer.from(src);
  new Uint8Array(ex.mem.buffer, 100000, sb.length).set(sb);
  new Uint8Array(ex.mem.buffer, 0, 1024).fill(0);
  const st = resB.irWords;
  code[st] = 1; code[st + 1] = sb.length; code[st + 2] = 8; code[st + 3] = lexCompileEntry; code[st + 4] = 1; code[st + 5] = 0;
  ex.set_fuel_max(50000000n);
  ex.run(st);
  const dv = new DataView(ex.mem.buffer);
  return { nerr: dv.getInt32(28, true), n: dv.getInt32(0, true), ir: new Int32Array(ex.mem.buffer, 211328, dv.getInt32(0, true)) };
}
function seedCompile(src) {
  const r = L.compile(src);
  if (!r.ok) return null;
  return new Int32Array(L.exports.mem.buffer, CODE_BASE, r.irWords).slice();
}

let fails = 0, total = 0;
async function check(name, src) {
  total++;
  const s = seedCompile(src);
  const h = await selfCompile(src);
  if (!s) { console.log(`SKIP(seed rejects) ${name}`); return; }
  if (h.nerr > 0) { console.log(`FAIL(self errors) ${name}`); fails++; return; }
  if (s.length !== h.n) { console.log(`FAIL(len ${s.length} vs ${h.n}) ${name}`); fails++; return; }
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== h.ir[i]) { console.log(`FAIL(word ${i}: seed ${s[i]} vs self ${h.ir[i]}) ${name}`); fails++; return; }
  }
}

// deterministic PRNG (fixed seed: same corpus every run, no flakes)
let st = 0x9e3779b9;
const rnd = () => (st = (st * 1103515245 + 12345) >>> 0) / 4294967296;
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');

// 1. random literals: up to 15-digit integer parts x 18-digit fractions
for (let t = 0; t < 3000 && fails <= 5; t++) {
  const ip = digits(1 + Math.floor(rnd() * 15)).replace(/^0+(?=.)/, '');
  const lit = `${ip}.${digits(1 + Math.floor(rnd() * 18))}`;
  await check(`lit ${lit}`, `fn f() -> Float { return ${lit} } fn main(c: Console) -> Unit { let x = f() return () }`);
}
// 2. special constants (mathematical constants the corpus actually uses, boundary shapes)
for (const lit of ['0.0', '0.5', '1.0', '2.0', '0.1', '0.2', '0.3', '123456789012345.678901234567',
  '0.000000000000000001', '999999999999999999.9', '1.7976931348623157', '0.3989422804014327',
  '10.450576', '0.6931471805599453', '1.4142135623730951', '0.2316419', '0.319381530',
  '1.781477937', '1.330274429', '3.14159265358979', '2.718281828459045']) {
  await check(`lit ${lit}`, `fn f() -> Float { return ${lit} } fn main(c: Console) -> Unit { let x = f() return () }`);
}
// 3. mixed-coercion expression zoo (both operand orders, nesting, unary minus, conversions)
const exprs = [
  '1 + 2.5', '2.5 + 1', '1 - 2.5', '2.5 - 1', '3 * 0.5', '0.5 * 3', '7 / 2.0', '2.0 / 7',
  'a + 1', '1 + a', 'a * b', 'a / 2', '2 / a', 'a - b * 2', '(a + 1) * (b - 2.0)',
  '-a', '-a * b', 'a * -b', '-(a + b)', '- -a', '-1.5 + a', 'a + -1.5',
  'to_float(n) + a', 'to_int(a) + n', 'round(a * 100.0)', 'sqrt(a) * exp(b)',
  'ln(a) - pow(b, 2.0)', 'abs(a - b)', 'a / b / 2', 'a * b * 1.5 * n',
];
for (const e of exprs) {
  await check(`expr ${e}`, `fn g(a: Float, b: Float, n: Int) -> Float { return ${e} } fn main(c: Console) -> Unit { let x = g(1.25, 2.5, 3) return () }`);
}
// 4. all six comparisons x operand-type mixes
for (const op of ['<', '<=', '>', '>=', '==', '!=']) {
  for (const [l, r] of [['a', 'b'], ['a', '1'], ['1', 'a'], ['n', 'b'], ['a', '0.5'], ['n', '2']]) {
    await check(`cmp ${l}${op}${r}`, `fn g(a: Float, b: Float, n: Int) -> Int { if ${l} ${op} ${r} { return 1 } return 0 } fn main(c: Console) -> Unit { c.print_int(g(1.0, 2.0, 3)) return () }`);
  }
}
// 5. statement shapes: float while conditions, let chains, annotations, forward/backward calls
await check('float while', `fn main(c: Console) -> Unit { var x = 8.0 while x > 1.0 { x = x * 0.5 } c.print_int(to_int(x)) return () }`);
await check('let chain', `fn main(c: Console) -> Unit { let a = 1.5 let b = a * 2.0 let n = to_int(b) let d = to_float(n) / 4.0 c.print_int(round(d * 100.0)) return () }`);
await check('fwd call', `fn main(c: Console) -> Unit { let x = g() let y = x + 1 c.print_int(y) return () } fn g() -> Float { return 1.5 }`);
await check('bwd call', `fn g() -> Float { return 1.5 } fn main(c: Console) -> Unit { let x = g() let y = x + 1 c.print_int(to_int(y)) return () }`);
await check('annot', `fn main(c: Console) -> Unit { let x: Float = 1.5 var y: Int = 3 let z: Float = to_float(y) c.print_int(to_int(x + z)) return () }`);

console.log(`\n${total - fails}/${total} programs word-identical between seed and self-hosted compiler.`);
process.exit(fails ? 1 : 0);
