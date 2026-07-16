// Hidden test for t17 (bisection root finder). Never shown to an author.
const EXPECTED = '3000000\n0\n1000000\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };

  const lines = r.stdout.split('\n').filter(l => l.length > 0);
  const checks = [];

  // Check 1: exact full-output match.
  checks.push(r.stdout === EXPECTED);

  // Check 2: case 1 (target=30, bracket [0,5]) is the exact cube root case, x=3.
  checks.push(lines[0] === '3000000');

  // Check 3 (edge case): case 2 (target=0, bracket [-5,5]) has the root exactly
  // at the initial midpoint (x=0); bisection must not skip or diverge on this.
  checks.push(lines[1] === '0');

  // Check 4: case 3 (target=2, bracket [0,2]), root x=1.
  checks.push(lines[2] === '1000000');

  const green = checks.every(c => c === true);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
