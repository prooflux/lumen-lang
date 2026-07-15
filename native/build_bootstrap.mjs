// Regenerate native/lumenc.bootstrap.c - the reproducible, wasm-free genesis of the native
// Lumen compiler. `clang lumenc.bootstrap.c -o lumenc0` yields the compiler with zero wabt /
// WebAssembly; lumenc0 then rebuilds the whole toolchain from source.
//
// Run this whenever lumenc.lm or emit_fn.lm changes and bootstrap_test.mjs reports drift.
// Generating it runs the seed once (that is the only remaining wasm use, and only at author
// time); the checked-in artifact is what the build and the trust chain consume.
import fs from 'node:fs';
import { emitLumencBootstrapC } from './lumenc_native.mjs';

const { csrc, entry } = await emitLumencBootstrapC();
fs.writeFileSync(new URL('./lumenc.bootstrap.c', import.meta.url), csrc);
console.log(`wrote native/lumenc.bootstrap.c (${(csrc.length / 1024).toFixed(0)} KB, lex_compile entry f${entry})`);
