// Hidden test for t24 (Collatz steps and peak). Never shown to an author.
const EXPECTED = '111\n9232\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const checks = [];

  const basic = r.ok === true && r.stdout === EXPECTED;
  checks.push(basic);

  // Two lines, nothing else printed.
  const lines = (r.stdout || '').split('\n').filter(x => x.length > 0);
  checks.push(r.ok === true && lines.length === 2);

  // Edge: the peak (9232) must exceed the starting value (27) and the step
  // count (111); a program that swaps the two prints or under/overshoots
  // the peak-tracking comparison will fail this even if steps happens to
  // line up.
  const peakIsBigger = r.ok === true && lines.length === 2 &&
    Number(lines[1]) > Number(lines[0]) && Number(lines[1]) === 9232;
  checks.push(peakIsBigger);

  const green = checks.every(Boolean);
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, checks } };
}
