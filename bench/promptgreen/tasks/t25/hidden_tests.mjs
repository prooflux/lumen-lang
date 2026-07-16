// Hidden test for t25 (digital root and additive persistence). Never shown to an author.
const EXPECTED = '2\n3\n7\n0\n0\n0\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) {
    return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, reason: 'compile/run failed' } };
  }
  const lines = r.stdout.split('\n');
  const check1 = lines[0] === '2' && lines[1] === '3'; // 9875 -> root 2, persistence 3
  const check2 = lines[2] === '7' && lines[3] === '0'; // single digit input, no steps
  const check3 = lines[4] === '0' && lines[5] === '0'; // edge case: zero input
  const green = check1 && check2 && check3 && r.stdout === EXPECTED;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, check1, check2, check3 } };
}
