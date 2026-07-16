// Hidden test for t14 (progressive tax brackets). Never shown to an author.
const EXPECTED = '1000.0\n0.0\n0.0\n1000.0\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  checks.push({ name: 'exact-stdout', pass: r.ok === true && r.stdout === EXPECTED });

  const lines = (r.stdout || '').split('\n').filter((l) => l.length > 0);
  checks.push({ name: 'four-lines', pass: lines.length === 4 });

  // Edge: boundary income (10000.00) must land entirely in bracket 1;
  // an off-by-one bracket split would leak into bracket 2.
  checks.push({ name: 'bracket2-zero-at-boundary', pass: lines[1] === '0.0' });
  checks.push({ name: 'total-matches-bracket1', pass: lines[3] === lines[0] });

  const green = checks.every((c) => c.pass);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
