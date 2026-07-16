// Hidden test for t28 (Fibonacci modulo, iterative with per-step reduction). Never shown to
// an author. fib(90) mod 1000000007 = 210345902; a solution that sums raw (unreduced)
// Fibonacci numbers before taking the modulo once at the end will silently overflow the
// ~2.1e9 Int-literal/arithmetic ceiling well before k=90 and land on a different number, so
// this single exact value already pins the "reduce every step" edge case.
const EXPECTED = '210345902\n';

export async function run(compileFn, source) {
  const r = compileFn(source);

  const compiled = r.ok === true;
  const lines = compiled ? r.stdout.split('\n') : [];
  const singleLine = compiled && lines.length === 2 && lines[1] === '';
  const exactMatch = compiled && r.stdout === EXPECTED;

  const green = compiled && singleLine && exactMatch;
  return {
    green,
    detail: {
      expected: EXPECTED,
      got: r.stdout,
      ok: r.ok,
      checks: { compiled, singleLine, exactMatch },
    },
  };
}
