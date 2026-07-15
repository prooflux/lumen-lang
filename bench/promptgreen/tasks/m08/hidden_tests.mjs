// Hidden test for m08 (sum types + match + ? variant). Never shown to an author.
const EXPECTED = 'value 6\nchannel closed\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  const green = r.ok === true && r.stdout === EXPECTED;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };
}
