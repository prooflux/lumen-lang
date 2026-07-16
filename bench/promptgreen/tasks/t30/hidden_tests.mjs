// Hidden test for t30 (running mean/variance). Never shown to an author.
const EXPECTED = '53000\n60100\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const ok = r.ok === true;
  const exact = ok && r.stdout === EXPECTED;

  const lines = ok ? r.stdout.trim().split('\n') : [];
  const twoLines = lines.length === 2;

  // Edge check: variance must never be negative (a broken Welford update,
  // e.g. dividing by n-1 instead of n, or reusing the pre-update delta,
  // still tends to produce a nonnegative number here, so pin the exact
  // value AND confirm the mean line alone lands within the data range
  // [2.0, 10.0] scaled by 10000, catching an accumulator that drifted).
  let meanInRange = false;
  if (twoLines) {
    const meanScaled = parseInt(lines[0], 10);
    meanInRange = Number.isFinite(meanScaled) && meanScaled >= 20000 && meanScaled <= 100000;
  }

  const green = exact && twoLines && meanInRange;
  return {
    green,
    detail: { expected: EXPECTED, got: r.stdout, ok, exact, twoLines, meanInRange },
  };
}
