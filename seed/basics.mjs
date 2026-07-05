// Lumen-mu basics: granular per-feature regression tests. The conformance suite (test.mjs)
// checks whole example programs end to end; this suite pins each language feature and each
// compiler behavior in isolation, so a change that breaks one basic fails one named test
// instead of a tangle of examples. Fast: one warm compiler for the whole run.
// Usage: node basics.mjs
import { createCompiler } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes } from './diagnostics.mjs';
import fs from 'node:fs';

const L = await createCompiler();
const runMain = body => L.run(`fn main(c: Console) -> Unit {\n${body}\n}\n`).stdout;
const runFull = src => L.run(src).stdout;
const codesOf = src => buildDiagnostics(L.compile(src).rawDiags, src).map(d => d.code + (d.name ? `:${d.name}` : ''));

let pass = 0, total = 0;
function eq(name, actual, expected) {
  total++;
  if (actual === expected) { pass++; console.log(`PASS  ${name}`); }
  else console.log(`FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
}
function deepEq(name, actual, expected) { eq(name, JSON.stringify(actual), JSON.stringify(expected)); }

// ---- arithmetic ----
eq('add',            runMain('c.print_int(2 + 3)'), '5\n');
eq('sub',            runMain('c.print_int(7 - 3)'), '4\n');
eq('sub goes negative', runMain('c.print_int(3 - 7)'), '-4\n');
eq('mul',            runMain('c.print_int(6 * 7)'), '42\n');
eq('div truncates',  runMain('c.print_int(7 / 2)'), '3\n');
eq('mod',            runMain('c.print_int(7 % 3)'), '1\n');
eq('precedence * over +', runMain('c.print_int(2 + 3 * 4)'), '14\n');
eq('parens override precedence', runMain('c.print_int((2 + 3) * 4)'), '20\n');

// ---- termination: an explicit `return` at the top of main must HALT, not underflow the call
// stack. Regression: run() enters main with csp=0 and pushes no frame, so main's RET did
// csp-- (to -1) and read a stale return PC (=0), re-executing from PC 0 in a fuel-bounded loop.
eq('explicit return () in main terminates', runMain('c.print_int(9)\n  return ()'), '9\n');
eq('return in main after work terminates', runFull('fn main(c: Console) -> Unit {\n  var s = 0\n  var i = 0\n  while i < 4 { s = s + i  i = i + 1 }\n  c.print_int(s)\n  return ()\n}\n'), '6\n');

// ---- Float: literals, arithmetic, comparison, Int<->Float, to_int/round ----
eq('float to_int truncates', runMain('c.print_int(to_int(2.9))'), '2\n');
eq('round up',     runMain('c.print_int(round(2.6))'), '3\n');
eq('round down',   runMain('c.print_int(round(2.4))'), '2\n');
eq('float add',    runMain('c.print_int(to_int(1.5 + 2.5))'), '4\n');
eq('float sub',    runMain('c.print_int(to_int(5.0 - 1.25))'), '3\n');
eq('float mul',    runMain('c.print_int(to_int(2.0 * 3.5))'), '7\n');
eq('float true div', runMain('c.print_int(to_int(7.0 / 2.0))'), '3\n');
eq('float precedence', runMain('c.print_int(to_int(1.0 + 2.0 * 3.0))'), '7\n');
eq('int+float coerces lhs', runMain('c.print_int(to_int(1 + 2.5))'), '3\n');
eq('float+int coerces rhs', runMain('c.print_int(to_int(2.5 + 1))'), '3\n');
eq('float compare lt',  runMain('c.print_int(2.5 < 3.0)'), '1\n');
eq('float compare le',  runMain('c.print_int(3.0 <= 2.5)'), '0\n');
eq('float param + return', runFull('fn dbl(r: Float) -> Float { return r * 2.0 }\nfn main(c: Console) -> Unit { c.print_int(round(dbl(1.5) * 10.0)) }\n'), '30\n');
eq('float let', runFull('fn main(c: Console) -> Unit {\n  let x: Float = 1.5\n  c.print_int(to_int(x + x))\n}\n'), '3\n');
eq('to_float of int', runMain('c.print_int(to_int(to_float(3) / 2.0 * 10.0))'), '15\n');

// ---- math builtins: sqrt, abs, exp, ln, pow ----
eq('sqrt',        runMain('c.print_int(round(sqrt(2.0) * 1000000.0))'), '1414214\n');
eq('abs of float unary minus', runMain('c.print_int(round(abs(-3.5) * 10.0))'), '35\n');
eq('exp(1)',      runMain('c.print_int(round(exp(1.0) * 1000000.0))'), '2718282\n');
eq('ln roundtrip', runMain('c.print_int(round(ln(exp(2.0)) * 1000000.0))'), '2000000\n');
eq('pow integer', runMain('c.print_int(round(pow(2.0, 10.0)))'), '1024\n');
eq('pow compound', runMain('c.print_int(round(pow(1.05, 3.0) * 1000000.0))'), '1157625\n');

// ---- arrays (heap-backed Float vectors): array(n) aget(a,i) aset(a,i,x) alen(a) ----
eq('array len', runMain('c.print_int(alen(array(5)))'), '5\n');
eq('array set/get', runFull('fn main(c: Console) -> Unit {\n  let a = array(2)\n  aset(a, 0, 1.5)\n  aset(a, 1, 2.5)\n  c.print_int(to_int((aget(a, 0) + aget(a, 1)) * 10.0))\n}\n'), '40\n');
eq('array sum loop', runFull('fn main(c: Console) -> Unit {\n  let a = array(3)\n  aset(a, 0, 10.0)\n  aset(a, 1, 20.0)\n  aset(a, 2, 30.0)\n  var s: Float = 0.0\n  var i: Int = 0\n  while i < alen(a) {\n    s = s + aget(a, i)\n    i = i + 1\n  }\n  c.print_int(to_int(s))\n}\n'), '60\n');
eq('array oob get is 0', runFull('fn main(c: Console) -> Unit {\n  let a = array(1)\n  aset(a, 0, 9.0)\n  c.print_int(to_int(aget(a, 5)))\n}\n'), '0\n');

// ---- records (compile-time sugar over arrays: field name -> stable global slot) ----
eq('record construct + field read', runFull('type Pt = { x: Float, y: Float }\nfn main(c: Console) -> Unit {\n  let p = Pt { x: 1.5, y: 2.5 }\n  c.print_int(to_int((p.x + p.y) * 10.0))\n}\n'), '40\n');
eq('record as fn param', runFull('type Cf = { amt: Float, t: Float }\nfn pv1(z: Cf, r: Float) -> Float { return z.amt / pow(1.0 + r, z.t) }\nfn main(c: Console) -> Unit {\n  let x = Cf { amt: 100.0, t: 2.0 }\n  c.print_int(round(pv1(x, 0.05) * 100.0))\n}\n'), '9070\n');

// ---- comparisons (1 = true, 0 = false) ----
eq('lt true',  runMain('c.print_int(3 < 7)'), '1\n');
eq('lt false', runMain('c.print_int(7 < 3)'), '0\n');
eq('le equal', runMain('c.print_int(5 <= 5)'), '1\n');
eq('gt true',  runMain('c.print_int(7 > 3)'), '1\n');
eq('ge less',  runMain('c.print_int(3 >= 7)'), '0\n');
eq('eq equal', runMain('c.print_int(5 == 5)'), '1\n');
eq('ne differ', runMain('c.print_int(5 != 6)'), '1\n');

// ---- logical operators: and / or, short-circuit, precedence ----
eq('and both true',   runMain('c.print_int(1 == 1 and 2 == 2)'), '1\n');
eq('and left false',  runMain('c.print_int(1 == 2 and 2 == 2)'), '0\n');
eq('and right false', runMain('c.print_int(1 == 1 and 2 == 3)'), '0\n');
eq('or left true',    runMain('c.print_int(1 == 1 or 2 == 3)'), '1\n');
eq('or right true',   runMain('c.print_int(1 == 2 or 3 == 3)'), '1\n');
eq('or both false',   runMain('c.print_int(1 == 2 or 3 == 4)'), '0\n');
eq('and binds tighter than or', runMain('c.print_int(1 == 2 and 1 == 1 or 1 == 1)'), '1\n');
eq('and lower than comparison', runMain('c.print_int(3 < 5 and 5 < 9)'), '1\n');
eq('or short-circuits past a trapping rhs',  runMain('c.print_int(1 == 1 or 1 / 0 == 0)'), '1\n');
eq('and short-circuits past a trapping rhs', runMain('c.print_int(1 == 2 and 1 / 0 == 0)'), '0\n');
eq('compound condition in if', runFull('fn in_range(x: Int, lo: Int, hi: Int) -> Int {\n  if x >= lo and x <= hi { return 1 }\n  return 0\n}\nfn main(c: Console) -> Unit {\n  c.print_int(in_range(5, 1, 10))\n  c.print_int(in_range(99, 1, 10))\n}\n'), '1\n0\n');

// ---- logical negation: not (prefix; binds looser than comparison, tighter than and/or) ----
eq('not nonzero',  runMain('c.print_int(not 5)'), '0\n');
eq('not zero',     runMain('c.print_int(not 0)'), '1\n');
eq('not over comparison', runMain('c.print_int(not 1 == 1)'), '0\n');   // not (1 == 1)
eq('not makes false true', runMain('c.print_int(not 1 == 2)'), '1\n');  // not (1 == 2)
eq('double not normalizes', runMain('c.print_int(not not 5)'), '1\n');
eq('not in and',   runMain('c.print_int(1 == 1 and not 0)'), '1\n');
eq('not grouped',  runMain('c.print_int(not (1 == 2 or 1 == 3))'), '1\n');

// ---- locals: let, multiple lets, var reassignment ----
eq('let binding', runMain('let x = 5\n  c.print_int(x + 1)'), '6\n');
eq('two lets',    runMain('let a = 3\n  let b = 4\n  c.print_int(a * b)'), '12\n');
eq('var reassignment', runMain('var i = 0\n  i = i + 10\n  c.print_int(i)'), '10\n');

// ---- control flow ----
eq('if true branch',  runMain('if 1 < 2 { c.print_int(1) }'), '1\n');
eq('if/else else branch', runMain('if 2 < 1 { c.print_int(1) } else { c.print_int(2) }'), '2\n');
// else-if ladders
const grade = 'fn grade(s: Int) -> Text {\n  if s >= 90 { return "A" }\n  else if s >= 80 { return "B" }\n  else if s >= 70 { return "C" }\n  else { return "F" }\n}\nfn main(c: Console) -> Unit {\n  c.print(grade(SCORE))\n}\n';
eq('else-if: first branch',  runFull(grade.replace('SCORE', '95')), 'A');
eq('else-if: middle branch', runFull(grade.replace('SCORE', '85')), 'B');
eq('else-if: later branch',  runFull(grade.replace('SCORE', '72')), 'C');
eq('else-if: final else',    runFull(grade.replace('SCORE', '40')), 'F');
eq('else-if: sibling branches can reuse a let name without reading a stale slot',
  runFull('fn t(d: Int) -> Int {\n  if d == 1 {\n    let x = 10\n    return x\n  } else if d == 2 {\n    let x = 20\n    return x\n  }\n  return 0\n}\nfn main(c: Console) -> Unit { c.print_int(t(2)) }\n'), '20\n');
eq('else-if followed by trailing statements in block',
  runFull('fn test_elseif(x: Int, c: Console) -> Unit {\n  if x == 1 {\n    c.print("one\\n")\n  } else if x == 2 {\n    c.print("two\\n")\n  }\n  c.print("after\\n")\n}\nfn main(c: Console) -> Unit {\n  test_elseif(1, c)\n  test_elseif(2, c)\n  test_elseif(3, c)\n}\n'),
  'one\nafter\ntwo\nafter\nafter\n');
eq('while loop sums 1..5', runMain('var i = 1\n  var s = 0\n  while i <= 5 { s = s + i\n    i = i + 1 }\n  c.print_int(s)'), '15\n');

// ---- functions: recursion, forward reference, multi-arg, mutual recursion ----
eq('recursion (factorial)', runFull('fn fac(n: Int) -> Int { if n < 2 { return 1 } return n * fac(n - 1) }\nfn main(c: Console) -> Unit { c.print_int(fac(5)) }\n'), '120\n');
eq('forward reference', runFull('fn main(c: Console) -> Unit { c.print_int(later(20)) }\nfn later(x: Int) -> Int { return x + 22 }\n'), '42\n');
eq('multi-arg call', runFull('fn add3(a: Int, b: Int, d: Int) -> Int { return a + b + d }\nfn main(c: Console) -> Unit { c.print_int(add3(1, 2, 3)) }\n'), '6\n');
eq('mutual recursion (is_even)', runFull('fn ev(n: Int) -> Int { if n == 0 { return 1 } return od(n - 1) }\nfn od(n: Int) -> Int { if n == 0 { return 0 } return ev(n - 1) }\nfn main(c: Console) -> Unit { c.print_int(ev(8)) }\n'), '1\n');

// ---- text ----
eq('print is raw (no newline)', runMain('c.print("hi")'), 'hi');
eq('newline escape in literal', runMain('c.print("a\\nb")'), 'a\nb');
eq('int_to_text', runMain('c.print(int_to_text(123))'), '123');
eq('text_concat', runMain('c.print(text_concat("foo", "bar"))'), 'foobar');
eq('text_eq true',  runMain('c.print_int(text_eq("x", "x"))'), '1\n');
eq('text_eq false', runMain('c.print_int(text_eq("x", "y"))'), '0\n');

// ---- sum types + match ----
eq('match nullary variant dispatch',
  runFull('type Color = | Red | Green | Blue\nfn show(co: Color, c: Console) -> Unit { match co { Red -> c.print("r\\n") Green -> c.print("g\\n") Blue -> c.print("b\\n") } }\nfn main(c: Console) -> Unit { show(Green, c) }\n'),
  'g\n');
eq('match ok binds payload, err dispatches',
  runFull('type E = | Bad\nfn d(x: Int) -> Result[Int, E] { if x == 0 { return err(Bad) } return ok(100 / x) }\nfn show(r: Result[Int, E], c: Console) -> Unit { match r { ok(v) -> c.print_int(v) err(e) -> c.print("bad\\n") } }\nfn main(c: Console) -> Unit { show(d(4), c)\n  show(d(0), c) }\n'),
  '25\nbad\n');
eq('match _ wildcard arm',
  runFull('type E = | Bad\nfn show(r: Result[Int, E], c: Console) -> Unit { match r { ok(v) -> c.print_int(v) err(_) -> c.print("e\\n") } }\nfn main(c: Console) -> Unit { show(ok(7), c)\n  show(err(Bad), c) }\n'),
  '7\ne\n');

// ---- the ? operator (ok unwraps, err short-circuits the enclosing fn) ----
const tryProg = ab => `type E = | Bad\nfn g(x: Int) -> Result[Int, E] { if x == 0 { return err(Bad) } return ok(x) }\nfn h(a: Int, b: Int) -> Result[Int, E] { let x = g(a)?\n  let y = g(b)?\n  return ok(x + y) }\nfn show(r: Result[Int, E], c: Console) -> Unit { match r { ok(v) -> c.print_int(v) err(_) -> c.print("e\\n") } }\nfn main(c: Console) -> Unit { show(h(${ab}), c) }\n`;
eq('? unwraps ok', runFull(tryProg('3, 4')), '7\n');
eq('? propagates err', runFull(tryProg('0, 4')), 'e\n');

// ---- unary minus / negative literals ----
eq('negative literal',            runMain('c.print_int(-5)'), '-5\n');
eq('unary minus on a binding',    runMain('let x = 5\n  c.print_int(-x)'), '-5\n');
eq('negative literal as call arg',
  runFull('fn id(n: Int) -> Int {\n  return n\n}\nfn main(c: Console) -> Unit {\n  c.print_int(id(-3))\n}\n'), '-3\n');
eq('double negation',             runMain('c.print_int(- -7)'), '7\n');
eq('unary minus inside an expression', runMain('c.print_int(10 + -4)'), '6\n');
eq('unary minus of a parenthesized expr', runMain('c.print_int(-(2 + 3))'), '-5\n');
eq('binary subtraction still works',   runMain('c.print_int(3 - 7)'), '-4\n');
eq('subtracting a negative',      runMain('c.print_int(3 - -7)'), '10\n');

// ---- diagnostics: each code, and a clean program ----
deepEq('E0001 unknown variable', codesOf('fn main(c: Console) -> Unit {\n  c.print_int(zzz)\n}\n'), ['E0001:zzz']);
deepEq('E0002 unknown function', codesOf('fn main(c: Console) -> Unit {\n  c.print_int(nope(1))\n}\n'), ['E0002:nope']);
deepEq('E0003 unexpected token', codesOf('fn main(c: Console) -> Unit {\n  @\n}\n'), ['E0003:@']);
deepEq('E0004 unterminated block', codesOf('fn main(c: Console) -> Unit {\n'), ['E0004']);
deepEq('clean program emits no diagnostics', codesOf('fn main(c: Console) -> Unit {\n  c.print_int(1)\n}\n'), []);
deepEq('grouping parser: one bad token inside grouping does not cascade',
  codesOf('fn main(c: Console) -> Unit {\n  let x = (1 + )\n}\nfn second(c: Console) -> Unit {\n  c.print_int(42)\n}\nfn third(c: Console) -> Unit {\n  c.print_int(100)\n}\n'),
  ['E0003:)']
);
deepEq('grouping parser: empty grouping return () does not cascade',
  codesOf('fn main(c: Console) -> Int {\n  return ()\n}\nfn second(c: Console) -> Unit {\n  c.print_int(42)\n}\n'),
  ['E0003:()']
);

// ---- confident fixes converge; valid code is untouched ----
function fixToClean(src) {
  let cur = src, rounds = 0;
  while (rounds++ < 20) {
    const d = buildDiagnostics(L.compile(cur).rawDiags, cur);
    if (!d.length) break;
    const r = applyFixes(cur, d);
    if (r.applied === 0 || r.source === cur) break;
    cur = r.source;
  }
  return { source: cur, clean: buildDiagnostics(L.compile(cur).rawDiags, cur).length === 0 };
}
eq('fix deletes an unexpected token and converges', fixToClean('fn main(c: Console) -> Unit {\n  @\n  c.print_int(1)\n}\n').clean, true);
eq('fix closes an unterminated block and converges', fixToClean('fn main(c: Console) -> Unit {\n  c.print_int(1)\n').clean, true);
{
  const valid = 'fn main(c: Console) -> Unit {\n  c.print_int(1)\n}\n';
  const d = buildDiagnostics(L.compile(valid).rawDiags, valid);
  eq('fix leaves valid code unchanged', applyFixes(valid, d).source, valid);
}

eq('loop stack corruption nested call', runFull(`
fn outer(x: Int, y: Int) -> Int {
  return x + y
}
fn inner(x: Int) -> Int {
  return load32(524288 + 8 + x * 4) + 1
}
fn main(c: Console) -> Unit {
  var l1 = 0
  var l2 = 0
  var l3 = 0
  var l4 = 0
  var l5 = 0
  var i = 0
  while i < 1014 {
    outer(i, inner(i))
    i = i + 1
  }
  c.print_int(42)
}
`), '42\n');

eq('loop stack corruption 10-arg call', runFull(`
fn ten_args(p1: Int, p2: Int, p3: Int, p4: Int, p5: Int, p6: Int, p7: Int, p8: Int, p9: Int, p10: Int) -> Int {
  return p1
}
fn main(c: Console) -> Unit {
  var i = 0
  while i < 2000 {
    ten_args(i, i, i, i, i, i, i, i, i, i)
    i = i + 1
  }
  c.print_int(99)
}
`), '99\n');

// ---- symbol table overflow ----
{
  let symSrc = '';
  for (let i = 0; i < 90; i++) symSrc += `fn f${i}(c: Console) -> Unit {}\n`;
  symSrc += 'fn main(c: Console) -> Unit {\n';
  for (let i = 0; i < 90; i++) symSrc += `  f${i}(c)\n`;
  symSrc += '}\n';
  deepEq('symbol overflow (90 functions) compiles clean', L.compile(symSrc).rawDiags.length, 0);
}
{
  let symSrcOver = '';
  for (let i = 0; i < 513; i++) symSrcOver += `fn f${i}(c: Console) -> Unit {}\n`;
  symSrcOver += 'fn main(c: Console) -> Unit {\n';
  symSrcOver += '}\n';
  eq('symbol overflow new guard', codesOf(symSrcOver)[0], 'E0003:f512');
}

// ---- unit expression support ----
eq('early return from Unit function', runFull('fn f(x: Int, c: Console) -> Unit {\n  if x {\n    return ()\n  }\n  c.print_int(7)\n}\nfn main(c: Console) -> Unit {\n  f(1, c)\n  f(0, c)\n}\n'), '7\n');
deepEq('negative: non-Unit function returning ()', codesOf('fn f(x: Int) -> Int { return () }\n'), ['E0003:()']);
deepEq('negative: non-Unit function let binding ()', codesOf('fn f(x: Int) -> Int { let x = () }\n'), ['E0003:()']);
deepEq('Unit function let binding ()', codesOf('fn f(x: Int) -> Unit { let x = () }\n'), []);
deepEq('lumenc.lm compiles clean', codesOf(fs.readFileSync('lumenc.lm', 'utf8')), []);

// ---- token capacity ----
{
  let tokSrc = 'fn main(c: Console) -> Unit {\n';
  for (let i = 0; i < 1333; i++) tokSrc += '  c.print_int(1)\n';
  tokSrc += '}\n';
  deepEq('token capacity (8000 tokens) compiles clean', L.compile(tokSrc).rawDiags.length, 0);
}
{
  let tokSrcOver = 'fn main(c: Console) -> Unit {\n';
  for (let i = 0; i < 2670; i++) tokSrcOver += '  c.print_int(1)\n';
  tokSrcOver += '}\n';
  eq('token capacity new guard', codesOf(tokSrcOver)[0], 'E0003');
}

console.log(`\n${pass}/${total} basics checks passed.`);
process.exit(pass === total ? 0 : 1);
