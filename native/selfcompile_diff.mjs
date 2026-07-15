// selfcompile_diff.mjs - the GAP-A/GAP-B gate: lumenc.lm compiling ITSELF, interpreted atop
// the seed WAT VM (no native pipeline involved - the same double-interpretation plumbing
// seed/selfhost_diff.mjs already proves out for the 31-program conformance floor, reused here
// for four much larger, real toolchain sources), must produce IR bit-identical to what the
// seed compiler produces for the same source, with ZERO diagnostics. This is a stronger bar
// than selfhost_diff's SELF(lumenc.lm) case: that one only checks lumenc.lm compiling itself.
// This gate additionally requires lumenc.lm to correctly compile the OTHER three files in its
// own toolchain (native/emit_fn.lm, native/optimize.lm, native/emit_llvm.lm) - each large
// enough (7.9k-14.4k tokens) to exercise codepaths the 31-program conformance floor never
// reaches (nested control flow, a full multi-KB C-emission preamble as one string literal,
// etc). See seed/lumenc.lm's own header comments for the two bugs this gate found and fixed
// (an `else if` chain parsed as two independent blocks; TOKENS' capacity silently truncated by
// the D4 region shift) plus the one it still reds on (native/emit_llvm.lm; see below).
//
// Second gate in this file: diagnostic fidelity. A handful of error-program snippets must
// produce IDENTICAL diagnostic code+name strings (e.g. 'E0007:+', not bare 'E0007' with the
// operator's span dropped) whether compiled by the seed or by lumenc.lm-under-interpretation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { createCompiler, CODE_BASE } from '../seed/compiler_core.mjs';
import { buildDiagnostics } from '../seed/diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedDir = path.join(__dirname, '../seed');

// Each toolchain source lumenc.lm must be able to compile bit-identically to the seed.
const TOOLCHAIN_SOURCES = [
  { label: 'native/emit_fn.lm', path: path.join(__dirname, 'emit_fn.lm') },
  { label: 'native/optimize.lm', path: path.join(__dirname, 'optimize.lm') },
  { label: 'native/emit_llvm.lm', path: path.join(__dirname, 'emit_llvm.lm') },
  { label: 'seed/lumenc.lm (SELF)', path: path.join(seedDir, 'lumenc.lm') },
];

// Diagnostic-fidelity cases: (source, expected code:name pair on BOTH compilers).
const DIAG_CASES = [
  {
    label: 'E0007 float+dec never mix (add), operator span preserved',
    src: 'fn main(c: Console) -> Unit {\n  c.print_int(to_int(1.5 + 1.50d))\n}\n',
    expected: ['E0007:+'],
  },
  {
    label: "E0008 '/' banned on Dec, operator span preserved",
    src: 'fn main(c: Console) -> Unit {\n  c.print_int(to_int(1.50d / 2.00d))\n}\n',
    expected: ['E0008:/'],
  },
];

async function main() {
  const wabt = await wabtInit();
  const watPath = path.join(seedDir, 'lumenc.wat');
  const wat = fs.readFileSync(watPath, 'utf8');
  const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  // Compile the wasm module ONCE; each program under test gets its own fresh instance.
  const module = await WebAssembly.compile(binary);

  const L = await createCompiler();
  const lmSrcPath = path.join(seedDir, 'lumenc.lm');
  const lmSrc = fs.readFileSync(lmSrcPath, 'utf8');
  const resB = L.compile(lmSrc);
  if (!resB.ok) {
    console.error('FATAL: the seed failed to compile seed/lumenc.lm itself!');
    process.exit(1);
  }
  const lmIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, resB.irWords).slice();

  // Locate lex_compile via the seed's own symbol table (same technique as selfhost_diff.mjs;
  // the stale-duplicate-lex redirect there is intentionally NOT reproduced here - lumenc.lm's
  // stale draft lexer was removed once the self-host floor advanced, and this gate would
  // rather fail loudly than silently patch around a *new* duplicate-symbol regression).
  // R5: compiler_core.mjs's exports.mem is the JS interpreter's RUN memory (CODE + heap only) -
  // it no longer mirrors the native compiler's own internal SYMBOLS/TOKENS scratch tables (see
  // that file's header comment), so a raw memory-poke at [170000,177000) reads zeroed bytes
  // post-rebase. compile()'s own `symbols` field (native_compile.mjs's parsed symtab trailer,
  // already resolved to {name, entry, ...}) is the R5 replacement source for this same data -
  // same technique lumenc_native.mjs's compileLumencRaw and seed/lumen_mcp.mjs's
  // symbolsFromSource already use.
  let lexCompileEntry = -1;
  for (const s of resB.symbols) {
    if (s.name === 'lex_compile') lexCompileEntry = s.entry;
  }
  if (lexCompileEntry === -1) {
    console.error('FATAL: lex_compile entry not found in lumenc.lm\'s symbol table.');
    process.exit(1);
  }

  // Drive lumenc.lm's own lex_compile(srclen) against an arbitrary source, exactly as
  // seed/selfhost_diff.mjs's compileSelfhost() does. Returns diag records too (read from
  // lumenc.lm's own DIAG region, seed/lumenc.lm: TOKENS()/DIAG layout comment).
  const DIAG_BASE_SELFHOSTED = 297000;
  async function compileSelfhost(testSource, fuelMax) {
    const instC = await WebAssembly.instantiate(module, { lumen: { console_print: () => {} } });
    const exC = instC.exports;
    new Int32Array(exC.mem.buffer, CODE_BASE, resB.irWords).set(lmIR);
    const testBytes = Buffer.from(testSource, 'utf8');
    new Uint8Array(exC.mem.buffer, 100000, testBytes.length).set(testBytes);
    new Uint8Array(exC.mem.buffer, 0, 1024).fill(0);
    const codeMem = new Int32Array(exC.mem.buffer, CODE_BASE, resB.irWords + 10);
    const stubIndex = resB.irWords;
    codeMem[stubIndex] = 1;                    // PUSH
    codeMem[stubIndex + 1] = testBytes.length; // srclen
    codeMem[stubIndex + 2] = 8;                // CALL
    codeMem[stubIndex + 3] = lexCompileEntry;
    codeMem[stubIndex + 4] = 1;                // argc
    codeMem[stubIndex + 5] = 0;                // HALT
    exC.set_fuel_max(BigInt(fuelMax));
    let crash = null;
    try { exC.run(stubIndex); } catch (e) { crash = String(e.message || e); }
    const memView = new DataView(exC.mem.buffer);
    const emitCount = memView.getInt32(0, true);
    const nerr = memView.getInt32(28, true);
    const emittedIR = new Int32Array(exC.mem.buffer, 211328, emitCount).slice();
    const u8 = new Uint8Array(exC.mem.buffer);
    const diags = [];
    for (let k = 0; k < nerr; k++) {
      const base = DIAG_BASE_SELFHOSTED + k * 12;
      const code = memView.getInt32(base, true);
      const off = memView.getInt32(base + 4, true);
      const len = memView.getInt32(base + 8, true);
      const name = (off >= 100000 && len > 0) ? Buffer.from(u8.slice(off, off + len)).toString('utf8') : '';
      diags.push({ code, byteOff: off - 100000, byteLen: len, name });
    }
    return { nerr, emitCount, emittedIR, diags, crash };
  }

  function compareIR(seedIR, shIR) {
    const maxLen = Math.max(seedIR.length, shIR.length);
    for (let i = 0; i < maxLen; i++) {
      if (seedIR[i] !== shIR[i]) return { ok: false, index: i, seedWord: seedIR[i], shWord: shIR[i] };
    }
    return { ok: true };
  }

  let pass = 0, fail = 0;
  console.log('--- GAP-A: lumenc.lm (interpreted) compiling each toolchain source, bit-identical + 0 diagnostics ---');
  for (const { label, path: srcPath } of TOOLCHAIN_SOURCES) {
    const src = fs.readFileSync(srcPath, 'utf8');
    const refRes = L.compile(src);
    if (!refRes.ok) {
      console.log(`FAIL  ${label}: the seed itself failed to compile this source (${refRes.rawDiags.length} diags) - fixture is broken, not a self-host bug`);
      fail++;
      continue;
    }
    const refIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, refRes.irWords).slice();
    const sh = await compileSelfhost(src, 60000000);
    if (sh.crash) {
      console.log(`FAIL  ${label}: lumenc.lm crashed (${sh.crash})`);
      fail++;
      continue;
    }
    if (sh.nerr > 0) {
      const codes = sh.diags.map(d => `E${String(d.code).padStart(4, '0')}${d.name ? ':' + d.name : ''}`);
      console.log(`FAIL  ${label}: lumenc.lm emitted ${sh.nerr} spurious diagnostic(s): ${codes.join(', ')}`);
      fail++;
      continue;
    }
    const diff = compareIR(refIR, sh.emittedIR);
    if (!diff.ok) {
      console.log(`FAIL  ${label}: IR diverges at word ${diff.index} (seed=${diff.seedWord} lumenc.lm=${diff.shWord}); seed ${refIR.length} words, lumenc.lm ${sh.emittedIR.length} words`);
      fail++;
      continue;
    }
    console.log(`PASS  ${label}: ${refIR.length} words bit-identical, 0 diagnostics`);
    pass++;
  }

  console.log('\n--- GAP-B: diagnostic fidelity (code+name string identical on both compilers) ---');
  for (const { label, src, expected } of DIAG_CASES) {
    const refRes = L.compile(src);
    const refCodes = buildDiagnostics(refRes.rawDiags, src).map(d => d.code + (d.name ? ':' + d.name : ''));
    const sh = await compileSelfhost(src, 5000000);
    const shCodes = sh.diags.map(d => `E${String(d.code).padStart(4, '0')}${d.name ? ':' + d.name : ''}`);
    const refMatch = JSON.stringify(refCodes) === JSON.stringify(expected);
    const shMatch = JSON.stringify(shCodes) === JSON.stringify(expected);
    if (refMatch && shMatch) {
      console.log(`PASS  ${label}: both compilers emit ${JSON.stringify(expected)}`);
      pass++;
    } else {
      console.log(`FAIL  ${label}: expected ${JSON.stringify(expected)}, seed emitted ${JSON.stringify(refCodes)}, lumenc.lm emitted ${JSON.stringify(shCodes)}`);
      fail++;
    }
  }

  console.log(`\nselfcompile_diff: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
