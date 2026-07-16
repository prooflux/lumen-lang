// Hidden test for t20 (dot product and norm). Never shown to an author.
const EXPECTED = '1200000\n142829\n0\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const okCompile = r.ok === true;
  const exact = r.stdout === EXPECTED;
  const gotLines = (r.stdout || '').split('\n').filter((l) => l.length > 0);
  const dotOk = gotLines[0] === '1200000';
  const normOk = gotLines[1] === '142829';
  const orthogonalZero = gotLines[2] === '0';
  const green = okCompile && exact && dotOk && normOk && orthogonalZero;
  return {
    green,
    detail: {
      expected: EXPECTED,
      got: r.stdout,
      ok: r.ok,
      checks: { okCompile, exact, dotOk, normOk, orthogonalZero },
    },
  };
}
