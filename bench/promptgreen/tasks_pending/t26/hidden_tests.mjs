// Hidden test for t26 (Zeller weekday index). Never shown to an author.
const EXPECTED = '0\n4\n5\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) {
    return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, reason: 'compile/run failed' } };
  }
  const lines = r.stdout.split('\n');
  const check1 = lines[0] === '0'; // 2000-01-01: January shift rule must fire; Saturday
  const check2 = lines[1] === '4'; // 2026-07-15: no shift rule needed
  const check3 = lines[2] === '5'; // 1900-03-01: century-boundary year, non-leap
  const green = check1 && check2 && check3 && r.stdout === EXPECTED;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, check1, check2, check3 } };
}
