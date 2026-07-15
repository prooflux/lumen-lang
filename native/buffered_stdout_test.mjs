// buffered_stdout_test.mjs (fix/llvm-stdout-buffering) - proves stdout buffering in
// native/runtime_llvm.c never loses output legitimately printed before an abrupt (non-exit())
// process termination, and quantifies the throughput win on a print-heavy program.
//
// Scope note (narrow slice, LLVM runtime side only - see the commit body for the full ruling):
// native/emit_fn.lm has its own, SEPARATE unbuffered setvbuf call plus two _exit() paths of its
// own (lm_out_of_fuel, lm_trap - a SIGBUS/SIGSEGV handler) that runtime_llvm.c does NOT share -
// confirmed by grep: neither "lm_out_of_fuel" nor "lm_trap" nor "signal(" nor "fuel" appears
// anywhere in runtime_llvm.c. That side is deliberately untouched here (tracked separately,
// scheduled after R5 retires the wasm path, since R5 rewires the exact host-side regex seams
// that hunt for emit_fn.lm's emitted setvbuf text). This file exercises ONLY the LLVM path
// (native/pipeline.mjs's buildAndRunLlvm, linked against runtime_llvm.c).
//
// exit(N) is standard-guaranteed to flush every open stdio stream before the process ends, so
// HALT (op 0, "call void @exit(i32 0)" in emit_llvm.lm's own .ll emission) needs no extra work
// under any buffering mode. abort() is NOT guaranteed to flush: every abort() site already
// reachable from a compiled program - runtime_llvm.c's own lm_dec_trap (Dec overflow/div-by-
// zero) and every inline-.ll IDIV/IMOD/DADD/DSUB/DFROMI trap block emit_llvm.lm emits - already
// call fflush immediately before abort(), independent of and prior to this change (verified by
// direct grep of runtime_llvm.c: every exit()/abort() call site has fflush on the immediately
// preceding line). Heap exhaustion (lm_anew/lm_alloc_bytes/lm_alloc_sum) already fflushes before
// its own exit(0) too. So unlike the emit_fn.lm side, there is no correctness gap to close here -
// this file's job is to PROVE that claim with real programs, not just assert it in a comment.
//
// Run: node buffered_stdout_test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAndRunLlvm, compileToIR, optimizeIR } from './pipeline.mjs';

let fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); fail++; }
}

// ---------------------------------------------------------------------------
// (a) print, then a Dec runtime trap (lm_dec_trap: fflush(NULL); abort();) - the printed prefix
// must survive. Reuses the exact trap shape D3's llvm_decimal_test.mjs already gates (a fresh
// literal chain avoids the tracked Int-literal-truncation bug, #25, the same way that file does).
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit {
  c.print("before-dec-trap\\n")
  let x = 9000000000000.0d + 9000000000000.0d
}
`;
  const r = await buildAndRunLlvm(src, '-O3');
  check(r.exit !== 0, `print-then-dec-overflow-trap: exits nonzero (got ${r.exit})`);
  check(r.stdout === 'before-dec-trap\n', `print-then-dec-overflow-trap: the printed prefix survives (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (b) print, then an Int div-by-zero trap - this trap is emitted INLINE in .ll text by
// emit_llvm.lm (fflush+abort in the IR itself, not a runtime_llvm.c function call), a different
// code path than (a) but the same process-wide stdout stream and buffering mode.
// ---------------------------------------------------------------------------
{
  const src = `fn main(c: Console) -> Unit { c.print_int(123) let x = 1 / 0 }`;
  const r = await buildAndRunLlvm(src, '-O3');
  check(r.exit !== 0, `print-then-div-zero-trap: exits nonzero (got ${r.exit})`);
  check(r.stdout === '123\n', `print-then-div-zero-trap: the printed prefix survives (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (c) print, then heap exhaustion (lm_anew's own fflush(stdout); exit(0);) - the printed prefix
// must survive. llvm_float_test.mjs's own heap_boundary cases put the print AFTER the
// allocations (so the over-boundary case asserts on EMPTY stdout, since the halt fires before
// the print is ever reached); this reorders print-then-allocate specifically to exercise the
// flush-on-the-way-out path with real prior output, which no existing test does.
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
  const r = await buildAndRunLlvm(src, '-O3');
  check(r.exit === 0, `print-then-heap-exhaustion: exits 0, the silent-halt idiom (got ${r.exit})`);
  check(r.stdout === 'before-heap-exhaustion\n', `print-then-heap-exhaustion: the printed prefix survives, halt fires before the second print (got ${JSON.stringify(r.stdout)})`);
}

// ---------------------------------------------------------------------------
// (d) sanity: an ordinary, non-trapping, multi-line-output program is still byte-identical under
// the new buffering mode (guards against a buffering bug silently reordering or truncating
// ordinary output, not just crash-adjacent output).
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
  const r = await buildAndRunLlvm(src, '-O3');
  check(r.stdout === want, `${N}-line ordinary program: byte-identical stdout under buffering (got ${r.stdout.length} chars, want ${want.length})`);
}

// ---------------------------------------------------------------------------
// (e) informational: quantify the win on a print-heavy program. Builds directly (mirroring
// buildAndRunLlvm's own steps) rather than through it, only because buildAndRunLlvm does not
// return the binary path needed to re-run it several times for a median.
// ---------------------------------------------------------------------------
async function buildLlvmBinary(src, opt) {
  const { emitLlvm } = await import('./pipeline.mjs');
  const llSrc = await emitLlvm(src);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-llvm-timing-'));
  const llfile = path.join(dir, 'p.ll'), bin = path.join(dir, 'p');
  fs.writeFileSync(llfile, llSrc);
  const runtimeFile = new URL('./runtime_llvm.c', import.meta.url).pathname;
  execFileSync('clang', [opt, '-o', bin, llfile, runtimeFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
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
  const bin = await buildLlvmBinary(src, '-O3');
  const out = execFileSync(bin, { encoding: 'utf8' });
  check(out.split('\n').filter(Boolean).length === N, `print-heavy (${N} lines) binary produces the right line count`);
  const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const times = [];
  for (let i = 0; i < 7; i++) {
    const t0 = process.hrtime.bigint();
    execFileSync(bin, { encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`INFO  print-heavy (${N} lines) LLVM-path binary, median of 7 runs: ${median(times).toFixed(2)}ms`);
}

console.log(fail === 0 ? '\nbuffered_stdout_test: all checks passed.' : `\nbuffered_stdout_test: ${fail} failure(s).`);
process.exit(fail === 0 ? 0 : 1);
