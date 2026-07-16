// Hidden test for t11 (flat monthly installment). Never shown to an author.
const EXPECTED_LINE1 = '1060.0';   // 12000.00, 6% annual, 12 months
const EXPECTED_LINE2 = '333.333333'; // edge case: rate_bps = 0, repeating division
const EXPECTED = EXPECTED_LINE1 + '\n' + EXPECTED_LINE2 + '\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) {
    return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };
  }
  const lines = r.stdout.split('\n');
  const check1 = lines[0] === EXPECTED_LINE1;
  const check2 = lines[1] === EXPECTED_LINE2; // edge case: zero rate
  const check3 = r.stdout === EXPECTED; // exact full output, nothing extra
  const green = check1 && check2 && check3;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, check1, check2, check3 } };
}
