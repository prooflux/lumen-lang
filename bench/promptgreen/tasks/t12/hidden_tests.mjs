// Hidden test for t12 (currency split). Never shown to an author.
const EXPECTED = '33.36\n33.36\n33.35\n30.0\n30.0\n30.0\n';

export async function run(compileFn, source) {
  const r = compileFn(source);
  if (r.ok !== true) {
    return { green: false, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok } };
  }
  const lines = r.stdout.split('\n').filter((_, idx, arr) => idx < arr.length - 1);
  // uneven split (100.07 / 3): first two shares take the extra cent, in order
  const check1 = lines[0] === '33.36' && lines[1] === '33.36' && lines[2] === '33.35';
  // even split (90.00 / 3): all shares identical
  const check2 = lines[3] === '30.0' && lines[4] === '30.0' && lines[5] === '30.0';
  // exact full-text match, nothing extra printed
  const check3 = r.stdout === EXPECTED;
  const green = check1 && check2 && check3;
  return { green, detail: { expected: EXPECTED, got: r.stdout, ok: r.ok, check1, check2, check3 } };
}
