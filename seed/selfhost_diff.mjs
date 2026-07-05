import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { createCompiler, CODE_BASE } from './compiler_core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFORMANCE_LIST = [
  '../mu/examples/fib_print.lm',
  '../mu/examples/add.lm',
  '../mu/examples/max.lm',
  '../mu/examples/fact.lm',
  '../mu/examples/locals.lm',
  '../mu/examples/forward.lm',
  '../mu/examples/mutual.lm',
  '../mu/examples/hello.lm',
  '../mu/examples/greet.lm',
  '../mu/examples/report.lm',
  '../mu/examples/compare.lm',
  '../mu/examples/gcd.lm',
  '../mu/examples/fizzbuzz.lm',
  '../mu/examples/count.lm',
  '../mu/examples/sum_loop.lm',
  '../mu/examples/bitwise.lm',
  '../mu/examples/safe_div.lm',
  '../mu/examples/propagate.lm',
];

// expected match floor: every program here must stay bit-identical or the harness exits 1.
// Only safe_div/propagate remain outside it (sum-type syntax not yet lexed by lumenc.lm).
const EXPECTED_MATCH = [
  '../mu/examples/fib_print.lm',
  '../mu/examples/add.lm',
  '../mu/examples/max.lm',
  '../mu/examples/fact.lm',
  '../mu/examples/locals.lm',
  '../mu/examples/forward.lm',
  '../mu/examples/mutual.lm',
  '../mu/examples/hello.lm',
  '../mu/examples/greet.lm',
  '../mu/examples/report.lm',
  '../mu/examples/compare.lm',
  '../mu/examples/gcd.lm',
  '../mu/examples/fizzbuzz.lm',
  '../mu/examples/count.lm',
  '../mu/examples/sum_loop.lm',
  '../mu/examples/bitwise.lm',
];

async function main() {
  const wabt = await wabtInit();
  const watPath = path.join(__dirname, 'lumenc.wat');
  const wat = fs.readFileSync(watPath, 'utf8');
  const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  // Compile the wasm module ONCE; per-program instantiation reuses the compiled Module
  // (instantiating from bytes re-JITs the whole module per program: ~25s of pure overhead).
  const module = await WebAssembly.compile(binary);

  // 1. Instantiate Instance B (cached build of compiler)
  const L = await createCompiler();
  const lmSrcPath = path.join(__dirname, 'lumenc.lm');
  const lmSrc = fs.readFileSync(lmSrcPath, 'utf8');
  const resB = L.compile(lmSrc);
  if (!resB.ok) {
    console.error('Failed to compile lumenc.lm under seed VM!');
    process.exit(1);
  }
  const lmIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, resB.irWords).slice();

  // Extract symbol table entries from Instance B memory to dynamically locate lex/lex_compile
  const memB = new DataView(L.exports.mem.buffer);
  const u8B = new Uint8Array(L.exports.mem.buffer);
  let lexCompileEntry = -1;
  const lexEntries = [];
  
  for (let addr = 150000; addr < 157000; addr += 12) {
    const name_off = memB.getInt32(addr, true);
    const name_len = memB.getInt32(addr + 4, true);
    const entry = memB.getInt32(addr + 8, true);
    if (name_off >= 100000 && name_off < 150000 && name_len > 0) {
      const name = Buffer.from(u8B.slice(name_off, name_off + name_len)).toString('utf8');
      if (name === 'lex_compile') {
        lexCompileEntry = entry;
      } else if (name === 'lex') {
        lexEntries.push(entry);
      }
    }
  }

  if (lexCompileEntry === -1 || lexEntries.length === 0) {
    console.error(`Symbols extraction failed. lex_compile: ${lexCompileEntry}, lex: ${lexEntries.length}`);
    process.exit(1);
  }

  // Function to setup and run instance C compiling a test program
  async function compileSelfhost(testSource) {
    const instC = await WebAssembly.instantiate(module, {
      lumen: { console_print: (p, l) => {} }
    });
    const exC = instC.exports;

    // Load compiler IR
    new Int32Array(exC.mem.buffer, CODE_BASE, resB.irWords).set(lmIR);

    // lumenc.lm defines `fn lex` twice (a stale draft at ~line 385 and the real lexer at
    // ~line 712); the seed's first-match symbol lookup binds calls to the stale one, which
    // traps at runtime (verified: unpatched instance C hits wasm memory-out-of-bounds).
    // Redirect CALLs from earlier lex entries to the last (current) definition. Once the
    // stale duplicate is removed from lumenc.lm this block self-disables (length === 1).
    const codeMem = new Int32Array(exC.mem.buffer, CODE_BASE, resB.irWords + 10);
    if (lexEntries.length > 1) {
      const staleEntries = new Set(lexEntries.slice(0, -1));
      const goodEntry = lexEntries[lexEntries.length - 1];
      const TWO_WORD = new Set([1, 2, 6, 7, 13, 14, 15, 25]); // PUSH GETARG JZ JMP RESERVE SETLOCAL MKTEXT MKSUM
      let i = 0;
      while (i < resB.irWords) {
        const op = codeMem[i];
        if (op === 8) {                          // CALL entry argc
          if (staleEntries.has(codeMem[i + 1])) codeMem[i + 1] = goodEntry;
          i += 3;
        } else if (op === 29) {                  // FPUSH lo hi
          i += 3;
        } else if (op === 57) {                  // TYPEMAP ntot rettype type_1..type_ntot
          i += codeMem[i + 1] + 3;
        } else if (TWO_WORD.has(op)) {
          i += 2;
        } else {
          i += 1;
        }
      }
    }

    // Write source at SRC() = 100000
    const testBytes = Buffer.from(testSource, 'utf8');
    new Uint8Array(exC.mem.buffer, 100000, testBytes.length).set(testBytes);

    // Zero globals region [0, 1024)
    new Uint8Array(exC.mem.buffer, 0, 1024).fill(0);

    // Stub at index resB.irWords
    const stubIndex = resB.irWords;
    codeMem[stubIndex] = 1; // PUSH
    codeMem[stubIndex + 1] = testBytes.length; // srclen
    codeMem[stubIndex + 2] = 8; // CALL
    codeMem[stubIndex + 3] = lexCompileEntry; // entry point
    codeMem[stubIndex + 4] = 1; // argc
    codeMem[stubIndex + 5] = 0; // HALT

    exC.set_fuel_max(50000000n); // 8x headroom over the 6.3M-step self-compile; a wedge halts in ~0.4s, not 13.6s
    exC.run(stubIndex);

    // Read outputs
    const memView = new DataView(exC.mem.buffer);
    const emitCount = memView.getInt32(0, true);
    const nerr = memView.getInt32(28, true);
    const emittedIR = new Int32Array(exC.mem.buffer, 211328, emitCount);

    return { nerr, emitCount, emittedIR };
  }

  // --- STEP 1: Probe Mode ---
  const addPath = path.join(__dirname, '../mu/examples/add.lm');
  const addSrc = fs.readFileSync(addPath, 'utf8');
  const seedRes = L.compile(addSrc);
  const seedIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, seedRes.irWords).slice();

  const shRes = await compileSelfhost(addSrc);

  console.log(`Interface Probe Values:`);
  console.log(`  nerr: ${shRes.nerr}`);
  console.log(`  emit count: ${shRes.emitCount}`);
  console.log(`  seed first 16 words: [${Array.from(seedIR.slice(0, 16)).join(', ')}]`);
  console.log(`  self-host first 16 words: [${Array.from(shRes.emittedIR.slice(0, 16)).join(', ')}]`);

  if (shRes.nerr > 0 || shRes.emitCount === 0) {
    console.log('STOP-RULE Triggered: nerr > 0 or emit count is 0');
    process.exit(1);
  }

  // --- STEP 2: Conformance Loop ---
  let matchCount = 0;
  let diffCount = 0;
  let errorCount = 0;
  const matchedPrograms = [];

  console.log('\n--- THE CENSUS ---');
  for (const relPath of CONFORMANCE_LIST) {
    const progName = path.basename(relPath);
    const progSrcPath = path.join(__dirname, relPath);
    const progSrc = fs.readFileSync(progSrcPath, 'utf8');

    // 1. Reference compile
    const refRes = L.compile(progSrc);
    const refIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, refRes.irWords).slice();

    // 2. Self-host compile
    let shRes;
    try {
      shRes = await compileSelfhost(progSrc);
    } catch (e) {
      shRes = { nerr: 1, emitCount: 0, emittedIR: new Int32Array(0), crash: String(e.message || e) };
    }

    if (shRes.nerr > 0) {
      console.log(`${progName}: SELFHOST-ERROR (nerr: ${shRes.nerr}${shRes.crash ? ', crash: ' + shRes.crash : ''})`);
      errorCount++;
      if (EXPECTED_MATCH.includes(relPath)) {
        console.error(`Error: Program ${relPath} was expected to MATCH but got SELFHOST-ERROR.`);
        process.exit(1);
      }
    } else {
      const diff = compareIR(refIR, shRes.emittedIR);
      if (diff.ok) {
        console.log(`${progName}: MATCH`);
        matchCount++;
        matchedPrograms.push(relPath);
      } else {
        console.log(`${progName}: DIFF (diverge at index ${diff.index}: seed ${diff.seedWord} vs selfhost ${diff.shWord})`);
        diffCount++;
        if (EXPECTED_MATCH.includes(relPath)) {
          console.error(`Error: Program ${relPath} was expected to MATCH but got DIFF.`);
          process.exit(1);
        }
      }
    }
  }

  // --- SELF: the fixpoint case. lumenc.lm compiles its own source; the reference is
  // instance B's seed-compiled IR (lmIR). Reported, not yet in the EXPECTED_MATCH floor.
  try {
    const selfRes = await compileSelfhost(lmSrc);
    if (selfRes.nerr > 0) {
      console.log(`SELF(lumenc.lm): SELFHOST-ERROR (nerr: ${selfRes.nerr})`);
    } else {
      const selfDiff = compareIR(lmIR, selfRes.emittedIR);
      if (selfDiff.ok) {
        console.log('SELF(lumenc.lm): MATCH');
      } else {
        console.log(`SELF(lumenc.lm): DIFF (diverge at index ${selfDiff.index}: seed ${selfDiff.seedWord} vs selfhost ${selfDiff.shWord})`);
      }
    }
  } catch (e) {
    console.log(`SELF(lumenc.lm): SELFHOST-ERROR (crash: ${String(e.message || e)})`);
  }

  const summary = `${matchCount}/17 bit-identical, ${diffCount} diff, ${errorCount} error`;
  console.log(`\nSummary: ${summary}`);
  console.log('Matched list:', JSON.stringify(matchedPrograms));
}

function compareIR(seedIR, selfhostIR) {
  const maxLen = Math.max(seedIR.length, selfhostIR.length);
  for (let idx = 0; idx < maxLen; idx++) {
    const seedWord = seedIR[idx];
    const shWord = selfhostIR[idx];
    if (seedWord !== shWord) {
      return { ok: false, index: idx, seedWord, shWord };
    }
  }
  return { ok: true };
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
