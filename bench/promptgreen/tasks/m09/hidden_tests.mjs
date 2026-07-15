// Hidden test for m09 (discounted payoff). Never shown to an author.
const EXPECTED = '19512\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const green = r.ok === true && r.stdout === EXPECTED;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };
}
