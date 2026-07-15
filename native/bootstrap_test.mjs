// Bootstrap gate: native/lumenc.bootstrap.c is the reproducible, wasm-free genesis of the
// native Lumen compiler. This proves two things so genesis can be `clang lumenc.bootstrap.c`
// with zero wabt / WebAssembly:
//
//   (1) Rot guard: re-emitting the bootstrap C from lumenc.lm + emit_fn.lm reproduces the
//       checked-in file byte-for-byte. If lumenc.lm or the emitter change, the checked-in C
//       must be regenerated (`node build_bootstrap.mjs`), so it can never silently drift.
//   (2) Genesis reproduces the compiler: clang-ing the checked-in C yields a native compiler
//       whose IR output on the real workload (lumenc.lm itself) is byte-identical to the
//       wasm-path build. So the C-bootstrapped compiler IS the native compiler, no wasm.
//
// This is the mrustc / GCC generated-source bootstrap: a large checked-in C file is a valid
// genesis seed precisely because it is mechanically reproduced from source and gated here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { emitLumencBootstrapC, buildLumencNative } from './lumenc_native.mjs';

let pass = true;
const checkedIn = fs.readFileSync(new URL('./lumenc.bootstrap.c', import.meta.url), 'utf8');

// (1) rot guard
const { csrc } = await emitLumencBootstrapC();
if (csrc === checkedIn) {
  console.log('PASS  re-emit matches checked-in native/lumenc.bootstrap.c');
} else {
  console.log('FAIL  native/lumenc.bootstrap.c is stale vs lumenc.lm/emit_fn.lm; run `node build_bootstrap.mjs`');
  pass = false;
}

// (2) wasm-free genesis reproduces the native compiler byte-for-byte
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-gate-'));
const cfile = path.join(dir, 'lumenc.bootstrap.c');
const bin0 = path.join(dir, 'lumenc0');
fs.writeFileSync(cfile, checkedIn);
execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin0, cfile]);
const { bin: wasmBuilt } = await buildLumencNative();
const src = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url));
const a = execFileSync(bin0, { input: src, maxBuffer: 1 << 28 });
const b = execFileSync(wasmBuilt, { input: src, maxBuffer: 1 << 28 });
if (Buffer.compare(a, b) === 0) {
  console.log(`PASS  clang(lumenc.bootstrap.c) reproduces the native compiler byte-for-byte (${a.length} bytes IR on lumenc.lm, zero wasm)`);
} else {
  console.log('FAIL  bootstrap-built compiler output differs from the wasm-path build');
  pass = false;
}

console.log(pass ? '\nbootstrap gate: PASS' : '\nbootstrap gate: FAIL');
process.exit(pass ? 0 : 1);
