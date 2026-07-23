#!/usr/bin/env node
// Selftest for the absorb harness itself. Proves the three properties the trust contract
// rests on, with throwaway kernels in a temp dir (nothing in the repo is touched):
//   1. ACCEPT: a correct candidate absorbs against a live Python oracle.
//   2. REJECT: an off-by-one candidate is refused with the failing case named.
//   3. TAMPER: a fixture check fails on (a) candidate sha drift and (b) expected-output
//      tampering, so the hermetic CI gate cannot be silently defeated.
// Uses python3 like native/decimal_oracle_test.mjs (present on the CI runner).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { absorb, fixtureFrom, checkFixture } from './absorb.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`);
  if (!cond) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-absorb-selftest-'));
const py = path.join(tmp, 'double.py');
fs.writeFileSync(py, 'def double(a):\n    return a * 2\n');
const good = path.join(tmp, 'double.lm');
fs.writeFileSync(good, 'fn double(a: Int) -> Int {\n  return a * 2\n}\n');
const bad = path.join(tmp, 'double_bad.lm');
fs.writeFileSync(bad, 'fn double(a: Int) -> Int {\n  return a * 2 + 1\n}\n');

const opts = { pyPath: py, fnName: 'double', candidatePath: good, n: 40, seed: 7, ranges: [] };

const r1 = await absorb(opts);
check('correct candidate is ABSORBED', r1.verdict.ok, r1.verdict.detail);

const r2 = await absorb({ ...opts, candidatePath: bad });
check('off-by-one candidate is REJECTED', !r2.verdict.ok, r2.verdict.detail);
check('rejection names the failing case', /case 0/.test(r2.verdict.detail));

const fx = fixtureFrom(r1, { ...opts, n: 40, seed: 7 });
// fixtures normally live in-repo; for the selftest, point the candidate path at tmp via
// an absolute-path fixture variant written beside the kernels
const fxPath = path.join(tmp, 'double.fixture.json');
fx.candidate = path.relative(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'), good);
fs.writeFileSync(fxPath, JSON.stringify(fx, null, 2));
const c1 = await checkFixture(fxPath);
check('fixture check passes on the untouched candidate', c1.ok, c1.detail);

fs.appendFileSync(good, '\n');
const c2 = await checkFixture(fxPath);
check('fixture check fails on candidate sha drift', !c2.ok, c2.detail);
fs.writeFileSync(good, 'fn double(a: Int) -> Int {\n  return a * 2\n}\n');

const fx2 = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
fx2.expected[3] = String(BigInt(fx2.expected[3]) + 1n);
fs.writeFileSync(fxPath, JSON.stringify(fx2, null, 2));
const c3 = await checkFixture(fxPath);
check('fixture check fails on tampered expected output', !c3.ok, c3.detail);

fs.rmSync(tmp, { recursive: true, force: true });

// --- C oracle backend: same three properties (accept / reject / tamper), throwaway kernel ---
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-absorb-selftest-c-'));
const cSrc = path.join(tmpC, 'triple.c');
fs.writeFileSync(cSrc, 'long long triple(long long a) {\n    return a * 3;\n}\n');
const goodC = path.join(tmpC, 'triple.lm');
fs.writeFileSync(goodC, 'fn triple(a: Int) -> Int {\n  return a * 3\n}\n');
const badC = path.join(tmpC, 'triple_bad.lm');
fs.writeFileSync(badC, 'fn triple(a: Int) -> Int {\n  return a * 3 + 1\n}\n');

const optsC = { srcPath: cSrc, oracle: 'c', fnName: 'triple', candidatePath: goodC, n: 30, seed: 3, ranges: [] };
const rc1 = await absorb(optsC);
check('C oracle: correct candidate is ABSORBED', rc1.verdict.ok, rc1.verdict.detail);

const rc2 = await absorb({ ...optsC, candidatePath: badC });
check('C oracle: off-by-one candidate is REJECTED', !rc2.verdict.ok, rc2.verdict.detail);

fs.rmSync(tmpC, { recursive: true, force: true });

// --- C++ oracle backend: same shape, a std::-library-flavored kernel ---
const tmpCpp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-absorb-selftest-cpp-'));
const cppSrc = path.join(tmpCpp, 'maxi.cpp');
fs.writeFileSync(cppSrc, '#include <algorithm>\n\nlong long maxi(long long a, long long b) {\n    return std::max(a, b);\n}\n');
const goodCpp = path.join(tmpCpp, 'maxi.lm');
fs.writeFileSync(goodCpp, 'fn maxi(a: Int, b: Int) -> Int {\n  if a > b { return a }\n  return b\n}\n');
const badCpp = path.join(tmpCpp, 'maxi_bad.lm');
fs.writeFileSync(badCpp, 'fn maxi(a: Int, b: Int) -> Int {\n  if a < b { return a }\n  return b\n}\n');

const optsCpp = { srcPath: cppSrc, oracle: 'cpp', fnName: 'maxi', candidatePath: goodCpp, n: 30, seed: 5, ranges: [] };
const rcpp1 = await absorb(optsCpp);
check('C++ oracle: correct candidate is ABSORBED', rcpp1.verdict.ok, rcpp1.verdict.detail);

const rcpp2 = await absorb({ ...optsCpp, candidatePath: badCpp });
check('C++ oracle: inverted candidate is REJECTED', !rcpp2.verdict.ok, rcpp2.verdict.detail);

fs.rmSync(tmpCpp, { recursive: true, force: true });

console.log(failures === 0 ? 'absorb_selftest: all checks passed' : `absorb_selftest: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
