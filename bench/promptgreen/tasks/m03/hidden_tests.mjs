// Hidden test for m03 (shipment notice). Never shown to an author.
const EXPECTED = 'shipment ready: pallets units\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];
  checks.push(r.ok === true);
  checks.push(r.stdout === EXPECTED);
  checks.push(r.stdout.endsWith(' units\n'));
  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
