// Hidden test for t19 (max drawdown). Never shown to an author.
const EXPECTED = '272727\n0\n';
const LINES = EXPECTED.split('\n').filter((l) => l.length > 0);

export async function run(compileFn, source) {
  const r = compileFn(source);
  const okCompile = r.ok === true;
  const exact = r.stdout === EXPECTED;
  const gotLines = (r.stdout || '').split('\n').filter((l) => l.length > 0);
  const edgeZero = gotLines[1] === '0';
  const firstLine = gotLines[0] === LINES[0];
  const green = okCompile && exact && edgeZero && firstLine;
  return {
    green,
    detail: {
      expected: EXPECTED,
      got: r.stdout,
      ok: r.ok,
      checks: { okCompile, exact, edgeZero, firstLine },
    },
  };
}
