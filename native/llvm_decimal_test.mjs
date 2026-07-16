// llvm_decimal_test.mjs (D3) - the Dec extension of the R3a gate: interpreter vs emit_llvm.lm's
// ops 64-70 (DPUSH/DFROMI/DADD/DSUB/DMUL/DDIV/D2TEXT) -> clang(.ll + runtime_llvm.c) -> exe.
// Same byte-for-byte, no-tolerance comparison approach as llvm_diff.mjs/llvm_float_test.mjs.
//
// Optimizer bypass (deliberate, not an oversight): D2 (#72) taught native/optimize.lm's
// oplen/oplen_out the 2-word DPUSH shape, so pass_a's own walk no longer desyncs on a Dec
// literal, but its is_known_op still caps at 63 (unchanged, and out of scope for this lane -
// optimize.lm is D2's territory), so every Dec op still takes the existing fail-safe bail-out
// and comes out unoptimized rather than corrupted. optimizeIR() is therefore SAFE on a
// Dec-bearing program today, just a no-op for it - this gate still bypasses it anyway (rather
// than relying on that bail-out) to keep the surface this test exercises minimal and to stay
// decoupled from a pass this lane doesn't own. buildAndRunLlvm() in pipeline.mjs always calls
// optimizeIR; this gate instead drives emitLlvm() directly (compileToIR -> emit_llvm.lm,
// exported and already optimizer-free) and does its own build+run tail, mirroring
// buildAndRunLlvm's tail byte-for-byte. Every non-Dec gate in this repo is unaffected: this
// file is additive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCompiler } from '../seed/compiler_core.mjs';
import { emitLlvm } from './pipeline.mjs';

async function buildAndRunLlvmUnopt(src, opt = '-O3') {
  const ll_src = await emitLlvm(src);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dec-llvm-'));
  const llfile = path.join(dir, 'p.ll'), bin = path.join(dir, 'p');
  fs.writeFileSync(llfile, ll_src);
  try {
    const runtimeFile = new URL('./runtime_llvm.c', import.meta.url).pathname;
    execFileSync('clang', [opt, '-o', bin, llfile, runtimeFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync(bin, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  return { stdout, exit, ll_src };
}

const lumen = await createCompiler();
let pass = 0, fail = 0;

// 1. mu/examples/decimal.lm - the full D1 transcript (12 lines, every op at least once)
{
  const name = 'decimal.lm';
  const src = fs.readFileSync(new URL('../mu/examples/decimal.lm', import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`FAIL  ${name} (interpreter compile error)`); fail++; }
  else {
    let cand;
    try { cand = await buildAndRunLlvmUnopt(src, '-O3'); }
    catch (e) { console.log(`FAIL  ${name}: ${e.message.slice(0, 300)}`); fail++; cand = null; }
    if (cand) {
      const ok = cand.stdout === ref.stdout;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} native=${JSON.stringify(cand.stdout.slice(0, 60))}... ref=${JSON.stringify(ref.stdout.slice(0, 60))}...`);
      if (ok) pass++; else fail++;
    }
  }
}

// 2. ~8 inline micro-programs (half-even tie both directions on dec_mul AND dec_div, negatives
// incl -0.000001d formatting, Int coercion both operand orders on +,-,*,dec_div, dec_to_text
// edge forms). Every goldenStdout below was independently derived three ways before this file
// was written: by hand from seed/lumenc.wat's $dec_mul/$dec_div/$dec2text algorithm, from a
// standalone native __int128 C harness, and from lumen.run() itself - all three agreed.
const CORPUS = [
  ['dec_mul_tie_down', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(0.25d * 2.000002d))
  c.print("\\n")
}
`, '0.5\n'],
  ['dec_mul_tie_up', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(0.25d * 2.000006d))
  c.print("\\n")
}
`, '0.500002\n'],
  ['dec_div_ties', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(dec_div(0.000001d, 2)))
  c.print("\\n")
  c.print(dec_to_text(dec_div(0.000003d, 2)))
  c.print("\\n")
}
`, '0.0\n0.000002\n'],
  ['dec_negatives', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(-1.5d + -2.5d))
  c.print("\\n")
  c.print(dec_to_text(-0.25d * 2.000006d))
  c.print("\\n")
  c.print(dec_to_text(-0.000001d))
  c.print("\\n")
}
`, '-4.0\n-0.500002\n-0.000001\n'],
  ['dec_int_coercion_add_sub', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(7 + 1.5d))
  c.print("\\n")
  c.print(dec_to_text(1.5d + 7))
  c.print("\\n")
  c.print(dec_to_text(10 - 1.5d))
  c.print("\\n")
  c.print(dec_to_text(1.5d - 10))
  c.print("\\n")
}
`, '8.5\n8.5\n8.5\n-8.5\n'],
  ['dec_int_coercion_mul_div', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(3 * 1.5d))
  c.print("\\n")
  c.print(dec_to_text(1.5d * 3))
  c.print("\\n")
  c.print(dec_to_text(dec_div(9.0d, 4)))
  c.print("\\n")
  c.print(dec_to_text(dec_div(9, 1.5d)))
  c.print("\\n")
}
`, '4.5\n4.5\n2.25\n6.0\n'],
  ['dec_to_text_edges', `fn main(c: Console) -> Unit {
  c.print(dec_to_text(7d))
  c.print("\\n")
  c.print(dec_to_text(1.234561d))
  c.print("\\n")
  c.print(dec_to_text(0d))
  c.print("\\n")
  c.print(dec_to_text(123456.780000d))
  c.print("\\n")
}
`, '7.0\n1.234561\n0.0\n123456.78\n'],
  ['dec_chained_kernel', `fn fee(principal: Dec, rate: Dec, months: Int) -> Dec {
  let base = principal + dec_div(principal * rate, 100)
  let deduction = months * 10
  return base - deduction
}

fn main(c: Console) -> Unit {
  c.print(dec_to_text(fee(2000.00d, 3.50d, 6)))
  c.print("\\n")
}
`, '2010.0\n'],
];

for (const [name, src, golden] of CORPUS) {
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`FAIL  ${name} (interpreter compile error)`); fail++; continue; }
  let cand;
  try { cand = await buildAndRunLlvmUnopt(src, '-O3'); }
  catch (e) { console.log(`FAIL  ${name}: ${e.message.slice(0, 300)}`); fail++; continue; }
  const ok = cand.stdout === ref.stdout && ref.stdout === golden;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} native=${JSON.stringify(cand.stdout)} ref=${JSON.stringify(ref.stdout)} gold=${JSON.stringify(golden)}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${pass + fail} decimal programs translated by emit_llvm.lm are bit-identical to the interpreter (fail ${fail})`);

// 3. Trap parity (Honesty rules): DADD overflow, dec_div by zero, DFROMI overflow. Each prints a
// prefix, then traps. Bug #25 ("Int literals silently truncate past i32 range in $lex") is now
// fixed (front-end constant synthesis in both $lex/$c_primary and their lumenc.lm mirrors, zero
// new opcodes - see mu/examples/int_big.lm and seed/corpus.mjs's census entry for the dedicated
// regression coverage). 'dfromi_overflow_trap' still reaches DFROMI's overflow path the original
// way (multiplying two small literals at runtime) precisely so this file's coverage is unchanged;
// 'dfromi_overflow_trap_big_literal' below is the cheap extra oracle case the fix makes possible:
// a single literal written directly past i32 range (2^53+1, already covered end to end by
// int_big.lm) now lexes correctly and DFROMI's overflow trap is reached from it directly, with
// no runtime-multiplication workaround needed.
const TRAPS = [
  ['dadd_overflow_trap', `fn main(c: Console) -> Unit {
  c.print_int(123)
  let x = 9000000000000.0d + 9000000000000.0d
}
`],
  ['dec_div_zero_trap', `fn main(c: Console) -> Unit {
  c.print_int(456)
  let x = dec_div(1.0d, 0)
}
`],
  ['dfromi_overflow_trap', `fn main(c: Console) -> Unit {
  c.print_int(789)
  let big = 1000000 * 1000000 * 10
  let x = big + 1.0d
}
`],
  ['dfromi_overflow_trap_big_literal', `fn main(c: Console) -> Unit {
  c.print_int(987)
  let big = 9007199254740993
  let x = big + 1.0d
}
`],
];

let trapPass = 0, trapFail = 0;
for (const [name, src] of TRAPS) {
  const ref = lumen.run(src);
  let cand;
  try { cand = await buildAndRunLlvmUnopt(src, '-O3'); }
  catch (e) { console.log(`FAIL  ${name}: ${e.message.slice(0, 300)}`); trapFail++; continue; }
  const stdoutOk = cand.stdout === ref.stdout;
  const exitOk = cand.exit !== 0;
  const ok = stdoutOk && exitOk;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} native=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref=${JSON.stringify(ref.stdout)} crash=${JSON.stringify(ref.crash)}`);
  if (ok) trapPass++; else trapFail++;
}

console.log(`${trapPass}/${TRAPS.length} trap-parity programs (fail ${trapFail})`);

process.exit(fail === 0 && trapFail === 0 ? 0 : 1);
