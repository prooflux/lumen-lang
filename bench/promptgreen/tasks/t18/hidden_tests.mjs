// Hidden test for t18 (Horner polynomial evaluation). Never shown to an author.
const EXPECTED = '40000\n0\n20000\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };

  const lines = r.stdout.split('\n').filter(l => l.length > 0);
  const checks = [];

  // Check 1: exact full-output match.
  checks.push(r.stdout === EXPECTED);

  // Check 2: point = 2 gives p(2) = 8 - 6 + 2 = 4 -> 40000.
  checks.push(lines[0] === '40000');

  // Check 3 (edge case): point = -2 is negative, so terms alternate sign;
  // p(-2) = -8 + 6 + 2 = 0 exactly (a root), must not print a near-zero noise value.
  checks.push(lines[1] === '0');

  // Check 4: point = 0 collapses the polynomial to its constant term, 2 -> 20000.
  checks.push(lines[2] === '20000');

  const green = checks.every(c => c === true);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
