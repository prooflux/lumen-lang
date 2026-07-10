// fixpoint_emit_test.mjs - regression gate for the emit_fn heap/IR-injection collision, AND
// the permanent clang-clean gate for the native C emitter.
//
// emit_fn.lm's `num` is `c.print(int_to_text(n))`, and int_to_text allocates a Text on the
// seed VM's bump heap (from 488000) that is never freed (no GC). When the injected IR sat in
// page 9 at 524288, a compiler-sized program (lumenc.lm, ~8.6k IR words) drove enough
// allocations that the heap's write pointer climbed past 524288 and OVERTOOK emit's IR read
// pointer mid-emit, overwriting un-read IR with Text bytes. The walk then read data as
// opcodes, hit a bogus CALL with a garbage argc, and emitted an unbounded argument list of
// zeros until the JS process OOM'd (`#error unsupported <bignum>` was the desync signature).
//
// The fix injects the emit_fn IR + its scratch (arity/ls/sty) into a 2MB high block, above
// the heap's max reach, so the heap grows harmlessly through page 9's now-stale compile-time
// tables. This gate proves the collision stays fixed: emit_fn emits lumenc.lm's own IR to
// completion, bounded, with no desync signature, walking the whole program.
//
// Slot-declaration completeness (the remaining native-fixpoint work this file used to flag)
// is now fixed and gated below: emit_header's field-slot declarations cover the body's actual
// max field index, not just the header's own fs operand, because the optimizer's dead-function
// elimination can strip a function's op-13 boundary while orphaning trailing dead-body field
// references (verified: those orphaned functions have zero callers anywhere in the program,
// so the extra declarations are unreachable and cannot change observable behavior). What
// remains beyond this gate is the native driver stage (lumenc/lumopt/lumemit as standalone
// binaries), not the compiler's own clang-cleanliness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileToIR, optimizeIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const LUMENC = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');
const OPTIMIZE_LM = fs.readFileSync(new URL('./optimize.lm', import.meta.url), 'utf8');
const EMIT_FN_LM = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');

let fail = 0;
function check(cond, msg) { if (cond) { console.log(`PASS  ${msg}`); } else { console.log(`FAIL  ${msg}`); fail++; } }

console.log('== native fixpoint: emit_fn emits the compiler without heap corruption ==');

// compileToIR throws on any diagnostic, so reaching the next line means a clean self-compile.
const ir = await compileToIR(LUMENC);
check(ir.irWords > 8000, `seed compiles lumenc.lm clean (${ir.irWords} IR words)`);

const opt = await optimizeIR(ir.words, ir.main);
check(opt.words.length > 8000, `optimizer runs on the compiler (${opt.words.length} words)`);

// The emit that used to OOM/desync. Under the old page-9 injection this throws (OOM) or
// returns corrupt C; under the fix it returns a bounded, complete translation.
let csrc = '';
try {
  csrc = await emitWith(EMIT_FN_SRC, opt.words, opt.main, [], EMIT_FN_BASE, EMIT_FN_CEIL);
} catch (e) {
  console.log(`FAIL  emit_fn(lumenc.lm) threw: ${String(e.message || e).slice(0, 160)}`);
  process.exit(1);
}

check(csrc.length > 0, `emit produced output (${csrc.length} bytes)`);
// A runaway allocated millions of bytes before OOM; a real translation of an 8.6k-word
// program is well under 2MB.
check(csrc.length < 2_000_000, `output is bounded (< 2MB; runaway was unbounded)`);
// The desync corrupted the opcode stream into invalid opcodes emitted as `#error unsupported`.
check(!csrc.includes('#error unsupported'), `no desync signature (#error unsupported absent)`);
// The walk must reach the end of the program. Labels are `L<pc>`; the highest must be near
// the optimized IR length, proving emit walked the whole IR without desyncing into garbage.
const labels = [...csrc.matchAll(/\bL(\d+):/g)].map(m => +m[1]);
const maxLabel = labels.length ? Math.max(...labels) : -1;
check(maxLabel >= opt.words.length - 60, `emit reached end of IR (max label L${maxLabel} of ${opt.words.length} words)`);
// A garbage argc emitted an absurd argument list; no single emitted call should have a
// wildly out-of-range function id (the runaway used f842610993).
check(!/\bf\d{7,}\(/.test(csrc), `no garbage callee ids (desync emitted f<9-digit>)`);

// ---------------------------------------------------------------------------------------
// Permanent clang-clean gate: all three self-hosting-critical programs, both IR variants
// (raw = straight out of the seed compiler, optimized = after optimize.lm's passes), must
// emit C that clang accepts under deterministic flags and links to a binary.
// ---------------------------------------------------------------------------------------
console.log('\n== clang-clean gate: 3 programs x {raw, optimized} ==');

function oplen(op) {
  if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) return 1;
  if (op === 8 || op === 29) return 2;
  return 0;
}

function collectStrings(words, irStrings) {
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { pc = pc + 3 + words[pc + 1]; continue; }
    if (op === 15) ptrs.push(words[pc + 1]);
    pc = pc + 1 + oplen(op);
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(irStrings.map(s => [s.ptr, s]));
  return uniquePtrs.map(ptr => {
    const s = stringsMap.get(ptr);
    if (!s) throw new Error(`string pointer ${ptr} not found in compile-time strings`);
    return s;
  });
}

const CLANG_PROGRAMS = [
  { name: 'lumenc', src: LUMENC },
  { name: 'optimize', src: OPTIMIZE_LM },
  { name: 'emit_fn', src: EMIT_FN_LM },
];

const clangDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-clangclean-'));
let clangOk = 0, clangTotal = 0;

for (const prog of CLANG_PROGRAMS) {
  const pir = await compileToIR(prog.src);
  const popt = await optimizeIR(pir.words, pir.main);
  const variants = [
    { name: 'raw', words: pir.words, main: pir.main },
    { name: 'optimized', words: popt.words, main: popt.main },
  ];
  for (const v of variants) {
    clangTotal++;
    const label = `${prog.name}/${v.name}`;
    let csrcV;
    try {
      const strings = collectStrings(v.words, pir.strings);
      csrcV = await emitWith(EMIT_FN_SRC, v.words, v.main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    } catch (e) {
      console.log(`FAIL  ${label}: emit threw: ${String(e.message || e).slice(0, 200)}`);
      fail++;
      continue;
    }
    const cfile = path.join(clangDir, `${prog.name}-${v.name}.c`);
    const bin = path.join(clangDir, `${prog.name}-${v.name}`);
    fs.writeFileSync(cfile, csrcV);
    try {
      execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
      console.log(`PASS  ${label}: clang-clean and linked`);
      clangOk++;
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : String(e.message || e);
      console.log(`FAIL  ${label}: clang rejected output:\n${stderr.slice(0, 800)}`);
      fail++;
    }
  }
}

check(clangOk === clangTotal, `clang-clean gate: ${clangOk}/${clangTotal} builds passed`);

console.log(fail === 0 ? '\nPASS: emit_fn translates the compiler with no heap corruption, and all 6 builds are clang-clean.' : `\nFAIL: ${fail} check(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
