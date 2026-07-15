// Hidden test for t16 (3-step binomial call option price). Never shown to an author.
const EXPECTED = '153061\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  checks.push(r.ok === true);
  checks.push(r.stdout === EXPECTED);
  // edge: a hand-verified known value; catches sign errors on the payoff (max with 0),
  // a swapped u/d, or discounting by R instead of R^3.
  checks.push(r.stdout.trim() !== '150000');
  // single-line integer output only
  checks.push((r.stdout.match(/\n/g) || []).length === 1);

  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
