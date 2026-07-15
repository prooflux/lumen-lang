// Hidden test for t29 (IRR by bisection). Never shown to an author.
const EXPECTED = '88963\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const ok = r.ok === true;
  const exact = ok && r.stdout === EXPECTED;

  // Sanity check: the printed integer must correspond to a rate strictly
  // between 0 and 100000000 (i.e. 0 < r < 100.0), since the cashflow
  // pattern (one outlay, three positive returns) guarantees a positive,
  // bounded IRR. This pins the edge that the bracket sign check must have
  // actually converged rather than saturating at an endpoint.
  let inRange = false;
  if (ok) {
    const n = parseInt(r.stdout.trim(), 10);
    inRange = Number.isFinite(n) && n > 0 && n < 100000000;
  }

  const single = ok && r.stdout.trim().split('\n').length === 1;

  const green = exact && inRange && single;
  return {
    green,
    detail: { expected: EXPECTED, got: r.stdout, ok, exact, inRange, single },
  };
}
