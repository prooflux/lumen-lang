// Hidden test for t21 (sliding window average). Never shown to an author.
const EXPECTED = '55000\n'.repeat(8);

export async function run(compileFn, source) {
  const r = compileFn(source);
  const lines = (r.stdout || '').trim().split('\n').filter(l => l.length > 0);
  const checkCount = r.ok === true && lines.length === 8;
  const checkAllConstant = checkCount && lines.every(l => l === '55000');
  const checkExact = r.ok === true && r.stdout === EXPECTED;
  const green = checkCount && checkAllConstant && checkExact;
  return {
    green,
    detail: {
      expected: EXPECTED,
      got: r.stdout,
      ok: r.ok,
      checkCount,
      checkAllConstant,
      checkExact,
    },
  };
}
