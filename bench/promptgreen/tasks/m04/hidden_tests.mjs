// Hidden test for m04 (boundary check). Never shown to an author.
const EXPECTED = '1\n0\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const lines = (r.stdout || '').split('\n');
  const checks = [];
  checks.push(r.ok === true);
  checks.push(r.stdout === EXPECTED);
  checks.push(lines[0] === '1');
  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
