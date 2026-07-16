// Hidden test for t22 (linear interpolation on a curve of pillars). Never shown to an author.
const EXPECTED_LINES = ['940000', '920000', '860000'];
const EXPECTED = EXPECTED_LINES.join('\n') + '\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const lines = (r.stdout || '').trim().split('\n').filter(l => l.length > 0);
  const checkCount = r.ok === true && lines.length === 3;
  // edge case: query year 3 lies exactly on a pillar (year 3, level 0.94) -> no
  // interpolation error should occur.
  const checkPillarExact = checkCount && lines[0] === '940000';
  const checkMidpoint = checkCount && lines[1] === '920000';
  const checkOffgrid = checkCount && lines[2] === '860000';
  const checkExact = r.ok === true && r.stdout === EXPECTED;
  const green = checkCount && checkPillarExact && checkMidpoint && checkOffgrid && checkExact;
  return {
    green,
    detail: {
      expected: EXPECTED,
      got: r.stdout,
      ok: r.ok,
      checkCount,
      checkPillarExact,
      checkMidpoint,
      checkOffgrid,
      checkExact,
    },
  };
}
