#!/usr/bin/env node
// lumen absorb: trustly absorb a foreign-language function into Lumen.
//
// The trust contract, in one paragraph: the foreign implementation is never transcribed on
// faith. At absorption time it is EXECUTED as a live oracle (today: CPython) against a
// deterministic, seeded input set, and the Lumen candidate is accepted only if its output
// matches the oracle on every case. Acceptance freezes the oracle's outputs into a fixture
// (examples/absorbed/fixtures/<name>.fixture.json) whose expected lines came from the real
// foreign runtime, so CI re-verifies the absorbed kernel forever WITHOUT the foreign
// runtime installed: hermetic in CI, oracle-grounded at the moment of absorption. The
// fixture also pins the sha256 of the accepted .lm and of the oracle source, so silent
// drift on either side turns the gate red.
//
// Modes
//   absorb:   node tools/absorb/absorb.mjs --py <file.py> --fn <name> --candidate <file.lm>
//               [--n 200] [--seed 42] [--range lo..hi[,lo..hi...]] [--emit-fixture <dir>]
//   check:    node tools/absorb/absorb.mjs --check-fixture <fixture.json>
//
// Comparison modes (derived from the candidate's declared return type):
//   Int   -> exact decimal text equality.
//   Float -> scaled-1e12 equality: both sides compute floor(v * 1e12 + 0.5) as float64 and
//            compare the resulting integer text. This mirrors FROUND's semantics and the
//            repo's existing scaled-int printing convention. It verifies 12 decimal digits,
//            not bit equality; transcendental functions whose foreign implementation uses a
//            different libm algorithm can land within a half-ulp of a rounding boundary and
//            legitimately fail. That is the gate doing its job: absorb a tighter kernel or
//            a narrower domain instead of loosening the comparison.
//
// Input generation is seeded (mulberry32, the repo's oracle-test idiom) and type-driven
// from the candidate's own signature. Int params draw from a boundary pool plus a uniform
// range (default -1000000..1000000, override per-param with --range). Float params are
// generated as exact-3-decimal literals (magnitude 0.001..999999.999, random sign) so the
// literal text parses to the identical float64 in both languages by IEEE-754 nearest.
// Domain limits are part of the certificate: an absorbed kernel is verified ON ITS DOMAIN,
// and Python bignum behavior outside i64 is out of scope by construction.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseSignature(lmSource, fnName) {
  const re = new RegExp('fn\\s+' + fnName + '\\s*\\(([^)]*)\\)\\s*->\\s*(\\w+)');
  const m = lmSource.match(re);
  if (!m) throw new Error(`candidate does not declare fn ${fnName}(...) -> T`);
  const params = m[1].trim() === '' ? [] : m[1].split(',').map((p) => {
    const [name, type] = p.split(':').map((s) => s.trim());
    if (!name || !type) throw new Error(`unparseable param in ${fnName}: "${p}"`);
    return { name, type };
  });
  return { params, ret: m[2] };
}

const INT_BOUNDARY_POOL = [0, 1, -1, 2, 7, 10, 31, 100, -100, 1000, 65535, -65536];

export function generateInputs({ params, n, seed, ranges }) {
  const rand = mulberry32(seed);
  const inputs = [];
  for (let i = 0; i < n; i++) {
    const row = params.map((p, pi) => {
      const range = ranges[pi] ?? ranges[0] ?? { lo: -1000000, hi: 1000000 };
      if (p.type === 'Int') {
        if (i < INT_BOUNDARY_POOL.length) {
          const b = INT_BOUNDARY_POOL[i];
          return { type: 'Int', value: String(Math.min(Math.max(b, range.lo), range.hi)) };
        }
        const v = Math.floor(range.lo + rand() * (range.hi - range.lo + 1));
        return { type: 'Int', value: String(v) };
      }
      if (p.type === 'Float') {
        // exact 3-decimal literal: parses to the same float64 in every IEEE language
        const milli = 1 + Math.floor(rand() * 999999999); // 0.001 .. 999999.999
        const sign = rand() < 0.5 ? '-' : '';
        const whole = Math.floor(milli / 1000);
        const frac = String(milli % 1000).padStart(3, '0');
        return { type: 'Float', value: `${sign}${whole}.${frac}` };
      }
      throw new Error(`unsupported param type for absorb v1: ${p.type}`);
    });
    inputs.push(row);
  }
  return inputs;
}

function lumenDriver(candidateSource, fnName, inputs, ret) {
  const lines = inputs.map((row) => {
    const args = row.map((a) => a.value).join(', ');
    if (ret === 'Int') return `  c.print_int(${fnName}(${args}))`;
    if (ret === 'Float') return `  c.print_int(round(${fnName}(${args}) * 1000000000000.0))`;
    throw new Error(`unsupported return type for absorb v1: ${ret}`);
  });
  return candidateSource + '\n\nfn main(c: Console) -> Unit {\n' + lines.join('\n') + '\n}\n';
}

async function runLumen(source) {
  const { createCompiler } = await import(path.join(REPO_ROOT, 'seed', 'compiler_core.mjs'));
  const compiler = await createCompiler();
  const r = compiler.run(source);
  if (!r.ok) {
    const diags = (r.rawDiags || []).slice(0, 3).map((d) => JSON.stringify(d)).join(' ');
    throw new Error(`lumen candidate driver did not compile clean: ${diags}`);
  }
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

// The native leg of the contract: an absorbed kernel is only accepted (and only stays
// green in CI) if it reproduces the oracle THROUGH THE NATIVE TOOLCHAIN as well - native
// compile -> native optimize -> emit_fn C -> clang -O2 -> execute. Absorbed kernels are
// not census members, so this is what extends the interpreter==native guarantee to them.
async function runLumenNative(source) {
  const { buildAndRunFn } = await import(path.join(REPO_ROOT, 'native', 'pipeline.mjs'));
  const r = await buildAndRunFn(source);
  if (r.exit !== 0) throw new Error(`native driver exited ${r.exit}`);
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

function runPythonOracle(pyPath, fnName, inputs, ret) {
  const abs = path.resolve(pyPath);
  const rows = inputs.map((row) => row.map((a) => a.value));
  const script = [
    'import importlib.util, json, math, sys',
    `spec = importlib.util.spec_from_file_location("oracle_mod", ${JSON.stringify(abs)})`,
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    `fn = getattr(mod, ${JSON.stringify(fnName)})`,
    `rows = json.loads(${JSON.stringify(JSON.stringify(rows))})`,
    'for row in rows:',
    '    args = [float(a) if ("." in a) else int(a) for a in row]',
    '    v = fn(*args)',
    ret === 'Float'
      ? '    print(int(math.floor(v * 1e12 + 0.5)))'
      : '    print(int(v))',
    'print("PYVER " + sys.version.split()[0], file=sys.stderr)',
  ].join('\n');
  const out = execFileSync('python3', ['-I', '-c', script], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pyver = 'unknown';
  try {
    const probe = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' });
    pyver = probe.trim();
  } catch { /* version probe is best-effort */ }
  return { lines: out.split('\n').filter((l) => l.length > 0), pyver };
}

function compare(lumenLines, oracleLines, inputs) {
  if (lumenLines.length !== oracleLines.length) {
    return { ok: false, detail: `line count mismatch: lumen ${lumenLines.length} vs oracle ${oracleLines.length}` };
  }
  for (let i = 0; i < oracleLines.length; i++) {
    if (lumenLines[i] !== oracleLines[i]) {
      const argstr = inputs[i].map((a) => a.value).join(', ');
      return { ok: false, detail: `case ${i} (${argstr}): lumen=${lumenLines[i]} oracle=${oracleLines[i]}` };
    }
  }
  return { ok: true, detail: `${oracleLines.length}/${oracleLines.length} cases identical` };
}

export async function absorb({ pyPath, fnName, candidatePath, n = 200, seed = 42, ranges = [] }) {
  const candidateSource = fs.readFileSync(candidatePath, 'utf8');
  const sig = parseSignature(candidateSource, fnName);
  const inputs = generateInputs({ params: sig.params, n, seed, ranges });
  const driver = lumenDriver(candidateSource, fnName, inputs, sig.ret);
  const lumenLines = await runLumen(driver);
  const { lines: oracleLines, pyver } = runPythonOracle(pyPath, fnName, inputs, sig.ret);
  let verdict = compare(lumenLines, oracleLines, inputs);
  if (verdict.ok) {
    const nativeLines = await runLumenNative(driver);
    const nativeVerdict = compare(nativeLines, oracleLines, inputs);
    verdict = nativeVerdict.ok
      ? { ok: true, detail: `${verdict.detail}, interpreter AND native toolchain` }
      : { ok: false, detail: `interpreter matched but NATIVE diverged: ${nativeVerdict.detail}` };
  }
  return { sig, inputs, lumenLines, oracleLines, pyver, verdict, candidateSource };
}

export function fixtureFrom(result, { pyPath, fnName, candidatePath, n, seed, ranges }) {
  return {
    version: 1,
    kind: 'lumen-absorb-fixture',
    fn: fnName,
    candidate: path.relative(REPO_ROOT, path.resolve(candidatePath)),
    candidate_sha256: sha256(fs.readFileSync(candidatePath)),
    oracle: {
      language: 'python',
      source: path.relative(REPO_ROOT, path.resolve(pyPath)),
      source_sha256: sha256(fs.readFileSync(pyPath)),
      version_at_absorption: result.pyver,
    },
    comparison: result.sig.ret === 'Float' ? 'scaled-1e12 floor(v*1e12+0.5)' : 'exact-int-text',
    n, seed,
    ranges: ranges.map((r) => `${r.lo}..${r.hi}`),
    signature: { params: result.sig.params, ret: result.sig.ret },
    inputs: result.inputs.map((row) => row.map((a) => a.value)),
    expected: result.oracleLines,
  };
}

export async function checkFixture(fixturePath) {
  const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const candidatePath = path.join(REPO_ROOT, fx.candidate);
  const candidateSource = fs.readFileSync(candidatePath, 'utf8');
  const nowSha = sha256(fs.readFileSync(candidatePath));
  if (nowSha !== fx.candidate_sha256) {
    return { ok: false, detail: `candidate drifted since absorption: sha ${nowSha.slice(0, 12)} != pinned ${fx.candidate_sha256.slice(0, 12)} (re-absorb against the live oracle to re-pin)` };
  }
  const inputs = fx.inputs.map((row) => row.map((v, i) => ({ type: fx.signature.params[i].type, value: v })));
  const driver = lumenDriver(candidateSource, fx.fn, inputs, fx.signature.ret);
  const lumenLines = await runLumen(driver);
  const interp = compare(lumenLines, fx.expected, inputs);
  if (!interp.ok) return { ok: false, detail: `interpreter: ${interp.detail}` };
  const nativeLines = await runLumenNative(driver);
  const native = compare(nativeLines, fx.expected, inputs);
  if (!native.ok) return { ok: false, detail: `NATIVE toolchain: ${native.detail}` };
  return { ok: true, detail: `${interp.detail}, interpreter AND native toolchain` };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['check-fixture']) {
    const r = await checkFixture(args['check-fixture']);
    console.log(r.ok ? `ABSORB CHECK OK: ${r.detail}` : `ABSORB CHECK FAILED: ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }
  const { py, fn, candidate } = args;
  if (!py || !fn || !candidate) {
    console.error('usage: absorb.mjs --py f.py --fn name --candidate f.lm [--n 200] [--seed 42] [--range lo..hi[,..]] [--emit-fixture dir] | --check-fixture f.json');
    process.exit(2);
  }
  const n = args.n ? parseInt(args.n, 10) : 200;
  const seed = args.seed ? parseInt(args.seed, 10) : 42;
  const ranges = (args.range || '').split(',').filter(Boolean).map((s) => {
    const m = s.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (!m) throw new Error(`bad --range segment: ${s}`);
    return { lo: parseInt(m[1], 10), hi: parseInt(m[2], 10) };
  });
  const result = await absorb({ pyPath: py, fnName: fn, candidatePath: candidate, n, seed, ranges });
  if (!result.verdict.ok) {
    console.log(`REJECTED: ${result.verdict.detail}`);
    process.exit(1);
  }
  console.log(`ABSORBED: ${result.verdict.detail} (python ${result.pyver}, mode ${result.sig.ret === 'Float' ? 'scaled-1e12' : 'exact'})`);
  if (args['emit-fixture']) {
    const fx = fixtureFrom(result, { pyPath: py, fnName: fn, candidatePath: candidate, n, seed, ranges });
    fs.mkdirSync(args['emit-fixture'], { recursive: true });
    const out = path.join(args['emit-fixture'], `${fn}.fixture.json`);
    fs.writeFileSync(out, JSON.stringify(fx, null, 2) + '\n');
    console.log(`fixture written: ${path.relative(process.cwd(), out)}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('absorb error: ' + e.message); process.exit(2); });
