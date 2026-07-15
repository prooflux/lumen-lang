// Hidden test for t15 (invoice ledger net amount). Never shown to an author.
const EXPECTED = '7.929688\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  checks.push(r.ok === true);
  checks.push(r.stdout === EXPECTED);
  // edge: the half-cent-scale tie inside dec_div(1.00, 0.008192) must resolve to
  // round-half-to-even (122.070312), not round-half-up (122.070313); a wrong tie rule
  // would shift the final digit of the net amount by one micro-unit.
  checks.push(r.stdout.trim() !== '7.929687');
  // no stray output before/after the single line
  checks.push((r.stdout.match(/\n/g) || []).length === 1);

  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
