// Hidden test for t13 (compound interest table). Never shown to an author.
const EXPECTED = '1013.7\n1027.58769\n1041.665641\n1055.93646\n1070.40279\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  checks.push({ name: 'exact-stdout', pass: r.ok === true && r.stdout === EXPECTED });

  const lines = (r.stdout || '').split('\n').filter((l) => l.length > 0);
  checks.push({ name: 'five-lines', pass: lines.length === 5 });

  // Edge: period 2 does not terminate at a clean digit count without the
  // odd basis-point rate (137) forcing extra fractional digits (5 digits:
  // 1027.58769); a naive truncation-only or floating-point implementation
  // tends to drift here.
  checks.push({ name: 'period-2-exact', pass: lines[1] === '1027.58769' });

  const green = checks.every((c) => c.pass);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
