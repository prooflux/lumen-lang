// native_buffered_stdout_test.mjs (S1b) - proves stdout buffering in native/emit_fn.lm's
// emitted C runtime (the per-function "beat C" backend, native/pipeline.mjs's buildAndRunFn)
// never loses output legitimately printed before an abrupt (non-exit()) process termination,
// and quantifies the throughput win on a print-heavy program.
//
// Scope note: this is the emit_fn.lm-side twin of native/buffered_stdout_test.mjs (#79, LLVM
// runtime path via runtime_llvm.c). That file's own header comment documented the gap this
// file closes: "native/emit_fn.lm has its own, SEPARATE unbuffered setvbuf call plus two
// _exit() paths of its own (lm_out_of_fuel, lm_trap - a SIGBUS/SIGSEGV handler) that
// runtime_llvm.c does NOT share" - tracked as W6-S1b there, this file is that follow-up.
//
// Exit-path inventory for native/emit_fn.lm's emitted preamble (verified by direct reading of
// the source, not assumed):
//   - op 0 (HALT) -> emits plain `exit(0)`. Standard-guaranteed to flush all open stdio streams
//     regardless of buffering mode. No fix needed.
//   - normal `return 0;` out of the emitted `int main(void){...}` -> ordinary process exit via
//     libc's exit path, same flush guarantee as above. No fix needed.
//   - Int DIV (op 12) / MOD (op 24) by-zero traps -> `if(...==0){fflush(stdout);abort();}`.
//     Already fflushes, unconditionally, before this change. No fix needed.
//   - lm_anew / lm_alloc_bytes / lm_alloc_sum (array/Text/sum-type heap exhaustion) ->
//     `{fflush(stdout); exit(0);}` in all three. Already fflushes. No fix needed.
//   - Dec DFROMI/DADD/DSUB overflow (ops 65/66/67), lm_dec_mul, lm_dec_div (ops 68/69) ->
//     every site is `{fflush(stdout);abort();}` (or trap on div-by-zero). Already fflushes.
//     No fix needed.
//   - lm_trap(int sig): the SIGBUS/SIGSEGV handler (installed as a constructor) -> wrote
//     directly to stderr then `_exit(70)`, with NO fflush(stdout) first. This was silently
//     safe only because stdout was unbuffered (_IONBF): every byte already reached the OS by
//     the time a signal could fire. Buffering without fixing this loses whatever prefix was
//     printed before the fault. FIXED here: fflush(stdout) added before the write+_exit.
//   - lm_out_of_fuel(void): the opt-in fuel-exhaustion trap (FUEL_MODE==1 only) -> same shape,
//     wrote stderr then `_exit(71)`, no fflush(stdout). Same hazard, same fix.
// These last two were the only unflushed abrupt-exit paths in the file; part (b)/(f) below
// exercise them directly (SIGSEGV trap and fuel trap), parts (c)/(d) exercise the
// already-safe div-by-zero and heap-exhaustion paths as regression coverage, and part (a)/(e)
// prove ordinary (non-trapping) output is untouched.
//
// Sequencing note (see the commit history this file's introduction is part of): this file was
// authored and verified GREEN against the UNMODIFIED (still-_IONBF) tree first - proving it is
// a meaningful baseline, not a test written to match already-buggy behavior. The setvbuf flip
// then landed in a separate commit WITHOUT the fflush fixes, at which point (b) and (f) here
// went RED (the prefix vanished), proving the test bites. The fflush fixes landed last,
// restoring green. `git log -p -- native/emit_fn.lm` for that exact sequence.
//
// Optimizer note (b): the SIGSEGV probe relies on a genuinely wild pointer write
// (store32 at an address far outside LMEM's static array) actually reaching hardware - this is
// undefined behavior in C, and Apple clang's -O2/-O3 were observed (empirically, on this
// machine) to prove the access unreachable and fold it away entirely (no crash, "after" prints
// too). -O0 was verified to reliably fault instead, so the SIGSEGV probe is built at -O0
// specifically; every other case here uses buildAndRunFn's default optimization level like the
// rest of this repo's native gates.
//
// Run: node native_buffered_stdout_test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAndRunFn } from './pipeline.mjs';
import { buildAndRunFnFueled } from './fuel_build.mjs';

let fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); fail++; }
}

// ---------------------------------------------------------------------------
// (a) sanity: an ordinary, non-trapping, multi-line-output program is byte-identical under the
// buffering mode in effect - guards against a buffering bug silently reordering or truncating
// ordinary output, not just crash-adjacent output.
// ---------------------------------------------------------------------------
{
  const N = 50;
  const src = `fn main(c: Console) -> Unit {
  var i = 0
  while i < ${N} {
    c.print_int(i)
    i = i + 1
  }
}
`;
  const want = Array.from({ length: N }, (_, i) => `${i}\n`).join('');
  const r = await buildAndRunFn(src, '-O3');
  check(r.stdout === want, `${N}-line ordinary program: byte-identical stdout under buffering (got ${r.stdout.length} chars, want ${want.length})`);
}

// ---------------------------------------------------------------------------
// (b) print, then a genuine SIGSEGV (a wild store32 write far outside LMEM) - lm_trap's own
// handler must fflush(stdout) before writing the stderr message and _exit(70), so the printed
// prefix survives. Built at -O0 (see the optimizer note above): -O2/-O3 were observed to fold
// the wild write away as unreachable UB, never faulting at all.
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit {
  c.print("before-sigsegv\\n")
  store32(9000000000000, 1)
  c.print("after\\n")
}
`;
  const r = await buildAndRunFn(src, '-O0');
  check(r.exit === 70, `print-then-sigsegv-trap: exits 70, the lm_trap controlled exit (got ${r.exit})`);
  check(r.stdout === 'before-sigsegv\n', `print-then-sigsegv-trap: the printed prefix survives (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (c) print, then an Int div-by-zero trap (op 12's inline `if(...==0){fflush(stdout);abort();}`)
// - already safe before this change; kept here as regression coverage under the new buffering
// mode, not a new gap this PR closes.
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit { c.print_int(123) let x = 1 / 0 }`;
  const r = await buildAndRunFn(src, '-O3');
  check(r.exit !== 0, `print-then-div-zero-trap: exits nonzero (got ${r.exit})`);
  check(r.stdout === '123\n', `print-then-div-zero-trap: the printed prefix survives (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (d) print, then heap exhaustion (lm_anew's own `{fflush(stdout); exit(0);}`) - already safe
// before this change; kept as regression coverage. Same n=2268/two-array boundary trick
// buffered_stdout_test.mjs (the LLVM twin) uses - LM_CAP_BYTES/AHEAP_CAP are the same numeric
// constants in both emit_fn.lm and runtime_llvm.c.
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit {
  c.print("before-heap-exhaustion\\n")
  let n = 2268
  let vols = array(n)
  let prices = array(n)
  c.print_int(999)
}
`;
  const r = await buildAndRunFn(src, '-O3');
  check(r.exit === 0, `print-then-heap-exhaustion: exits 0, the silent-halt idiom (got ${r.exit})`);
  check(r.stdout === 'before-heap-exhaustion\n', `print-then-heap-exhaustion: the printed prefix survives, halt fires before the second print (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (e) print, then a runaway loop with FUEL_MODE on and an ample budget - fuel-on must not
// change ordinary results, byte-identical stdout to fuel-off, matching fuel_test.mjs's own
// convention (b).
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit {
  var i = 0
  var sum = 0
  while i < 10000 {
    sum = sum + i
    i = i + 1
  }
  c.print_int(sum)
}
`;
  const off = await buildAndRunFn(src, '-O2');
  const on = await buildAndRunFnFueled(src, 1500000000, '-O2');
  check(on.exit === 0 && on.stdout === off.stdout, `fuel-on ample budget: byte-identical to fuel-off (fueled=${JSON.stringify(on.stdout)} unfueled=${JSON.stringify(off.stdout)}, fueled exit=${on.exit})`);
}

// ---------------------------------------------------------------------------
// (f) print, then run out of fuel (lm_out_of_fuel's own _exit(71)) - the printed prefix must
// survive on stdout, and "lumen: out of fuel" must still land on stderr. This is the second of
// the two hazard sites this PR closes (see the header comment's exit-path inventory).
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit {
  c.print("before-out-of-fuel\\n")
  var i = 0
  while i < 2000000000 {
    i = i + 1
  }
  c.print_int(i)
}
`;
  const r = await buildAndRunFnFueled(src, 5000, '-O2');
  check(r.exit === 71, `print-then-out-of-fuel: exits 71 (got ${r.exit})`);
  check(r.stderr === 'lumen: out of fuel\n', `print-then-out-of-fuel: stderr carries the fuel message (got ${JSON.stringify(r.stderr)})`);
  check(r.stdout === 'before-out-of-fuel\n', `print-then-out-of-fuel: the printed prefix survives (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (g) informational: quantify the win on a print-heavy program built through the native
// (emit_fn.lm / C) pipeline. Builds directly (mirroring buildAndRunFn's own steps) rather than
// through it, only because buildAndRunFn does not return the binary path needed to re-run it
// several times for a median.
// ---------------------------------------------------------------------------
async function buildFnBinary(src, opt) {
  const r = await buildAndRunFn(src, opt);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fn-timing-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, r.csrc);
  execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { bin, stdout: r.stdout };
}
{
  const N = 50000;
  const src = `fn main(c: Console) -> Unit {
  var i = 0
  while i < ${N} {
    c.print_int(i)
    i = i + 1
  }
}
`;
  const { bin, stdout } = await buildFnBinary(src, '-O3');
  check(stdout.split('\n').filter(Boolean).length === N, `print-heavy (${N} lines) binary produces the right line count`);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const timeRun = (b) => { const t = process.hrtime.bigint(); execFileSync(b, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };
  const times = [];
  for (let i = 0; i < 7; i++) times.push(timeRun(bin));
  console.log(`INFO  print-heavy (${N} lines) native (emit_fn.lm/C-path) binary, median of 7 runs: ${median(times).toFixed(2)}ms`);
}

console.log(fail === 0 ? '\nnative_buffered_stdout_test: all checks passed.' : `\nnative_buffered_stdout_test: ${fail} failure(s).`);
process.exit(fail === 0 ? 0 : 1);
