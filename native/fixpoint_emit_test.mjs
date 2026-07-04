// fixpoint_emit_test.mjs - regression gate for the emit_fn heap/IR-injection collision.
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
// It intentionally does NOT require the emitted C to clang-compile: making emit_fn emit
// clang-clean C for the full compiler is the remaining native-fixpoint work (slot-declaration
// completeness, etc.). This gate isolates the ONE property this fix guarantees.
import fs from 'node:fs';
import { compileToIR, optimizeIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const LUMENC = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');

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

console.log(fail === 0 ? '\nPASS: emit_fn translates the compiler with no heap corruption.' : `\nFAIL: ${fail} check(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
