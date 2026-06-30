// Lumen-mu basics: granular per-feature regression tests. The conformance suite (test.mjs)
// checks whole example programs end to end; this suite pins each language feature and each
// compiler behavior in isolation, so a change that breaks one basic fails one named test
// instead of a tangle of examples. Fast: one warm compiler for the whole run.
// Usage: node basics.mjs
import { createCompiler } from './compiler_core.mjs';
import { buildDiagnostics, applyFixes } from './diagnostics.mjs';

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

console.log(`\n${pass}/${total} basics checks passed.`);
process.exit(pass === total ? 0 : 1);
