// Hidden test for t23 (prime count sieve). Never shown to an author.
const EXPECTED = '168\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  const basic = r.ok === true && r.stdout === EXPECTED;
  checks.push(basic);

  // Edge: output must be exactly one line, no stray prints.
  const singleLine = r.ok === true && r.stdout.split('\n').filter(x => x.length > 0).length === 1;
  checks.push(singleLine);

  // Edge: 997 is the largest prime below 1000; a sieve that mis-handles the
  // upper boundary (e.g. off-by-one on N or on the inner marking loop) will
  // not land on exactly 168.
  const exactCount = r.ok === true && r.stdout.trim() === '168';
  checks.push(exactCount);

  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
