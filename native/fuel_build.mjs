// fuel_build.mjs - opt-in native fuel counter build helper (SaaS Stone C: metering/billing/
// hard-isolation primitive). Mirrors buildAndRunFn in pipeline.mjs exactly, but before running
// emit_fn.lm it sets the two fuel-flag words in the fresh emit instance's memory:
//   FUEL_MODE_ADDR   = 2500000 (i32: 1 = on)
//   FUEL_BUDGET_ADDR = 2500004 (i32: the budget)
// emit_fn.lm reads these itself (see fuel_mode()/fuel_budget() there) and, only when
// FUEL_MODE==1, additionally emits a fuel counter in the C preamble plus a decrement-and-trap
// check at every basic-block label. FUEL_MODE==0 (the default, used by every other caller in
// this repo) is untouched: nothing here is invoked unless a caller opts in via this file.
//
// Does NOT edit pipeline.mjs. Re-implements the same emitWith/clang/run staging locally so the
// existing fuel-off call path is provably byte-for-byte unaffected.
//
// R5: this file is a DELIBERATE, ISOLATED exception to the wasm retirement, matching the same
// pattern as pipeline.mjs's LLVM backend and native/arm64_spike_check.mjs's custom emitter. The
// R4 checked-in emitter bootstrap (emit_fn.bootstrap.c)'s stdin/stdout driver protocol has no way
// to inject the two fuel-flag words before running (native/lumemit_native.mjs's
// patchMainToEmitDriver only stages the IR+strings payload) - extending that protocol for this
// one opt-in, not-yet-shipped feature (this file's own header: "SaaS Stone C", an experimental
// primitive, isolated by design from the main pipeline) was judged lower-priority than the core
// compile/run/check/fix/diff-gate work R5 actually blocks on. Only this file and
// native/fuel_test.mjs (its one caller) touch wasm; every other fuel-cap-related test (the
// interpreter's OWN termination guarantee - see native/ir_interpreter.mjs's fuel_max - and
// seed/safety.mjs's Group 2) is fully native. Tracked as a follow-up alongside the LLVM native
// bootstrap in the R5 PR body.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import wabtInit from 'wabt';
import { compileToIR, optimizeIR, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const FUEL_MODE_ADDR = 2500000;
const FUEL_BUDGET_ADDR = 2500004;

const wabt = await wabtInit();
const wat = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const SRC_BASE = 100000;

async function freshInstance() {
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  return { ex: instance.exports, getOut: () => out, resetOut: () => { out = ''; } };
}

function writeSrc(I, src) {
  const b = Buffer.from(src, 'utf8');
  if (b.length > 70000) throw new Error(`source ${b.length}B exceeds SRC capacity`);   // D4: matches widened SRC region
  new Uint8Array(I.ex.mem.buffer, SRC_BASE, b.length).set(b);
  return b.length;
}

// run emit_fn.lm with fuel flags set in the fresh instance's memory BEFORE run().
async function emitFueled(words, main, strings, budget) {
  const I = await freshInstance();
  const len = writeSrc(I, EMIT_FN_SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emit_fn.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[EMIT_FN_BASE / 4] = words.length;
  m32[EMIT_FN_BASE / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[EMIT_FN_BASE / 4 + 2 + i] = words[i];

  const offset_words = 2 + words.length;
  const dir_word_count = 3 * strings.length;
  m32[EMIT_FN_BASE / 4 + offset_words] = dir_word_count;
  let current_byte_offset = EMIT_FN_BASE + (offset_words + 1 + dir_word_count) * 4;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const triple_idx = EMIT_FN_BASE / 4 + offset_words + 1 + 3 * i;
    m32[triple_idx] = s.ptr;
    m32[triple_idx + 1] = s.len;
    m32[triple_idx + 2] = current_byte_offset;
    const m8 = new Uint8Array(I.ex.mem.buffer);
    m8.set(s.bytes, current_byte_offset);
    current_byte_offset += s.len;
  }
  if (current_byte_offset > EMIT_FN_CEIL) {
    throw new Error(`IR + sidecar exceed injection capacity (size ${current_byte_offset - EMIT_FN_BASE}B, ceil ${EMIT_FN_CEIL})`);
  }

  // Set the fuel flags AFTER the IR/string injection (same region relationship as pipeline.mjs's
  // own base/ceil convention) but BEFORE run() so emit_fn.lm's main() observes them from the start.
  m32[FUEL_MODE_ADDR / 4] = 1;
  m32[FUEL_BUDGET_ADDR / 4] = budget | 0;

  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}

// build + run a Lumen source with the native fuel counter turned ON, budget instructions.
export async function buildAndRunFnFueled(src, budget, opt = '-O2') {
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);

  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) {
      pc = pc + 3 + words[pc + 1];
    } else {
      if (op === 15) ptrs.push(words[pc + 1]);
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
      else if (op === 8 || op === 29) oplen = 2;
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map(s => [s.ptr, s]));
  const strings = uniquePtrs.map(ptr => {
    const s = stringsMap.get(ptr);
    if (!s) throw new Error(`Internal error: string pointer ${ptr} not found in compile-time strings`);
    return s;
  });

  const csrc = await emitFueled(words, main, strings, budget);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fuel-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  try { execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
  const r = spawnSync(bin, { encoding: 'utf8' });
  const stdout = r.stdout || '';
  const stderrOut = r.stderr || '';
  const exit = typeof r.status === 'number' ? r.status : 1;
  return { stdout, exit, csrc, stderr: stderrOut, bin };
}
