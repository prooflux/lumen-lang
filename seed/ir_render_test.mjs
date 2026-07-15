// ir_render_test.mjs - regression test for compiler_core.mjs's ir() disassembly (`lumen ir`).
//
// DPUSH(64) and FPUSH(29) both carry a 2-word immediate (like CALL's entry+argc), and TYPEMAP(57)
// is a variable-length record (3+ntot words). None of the three was accounted for correctly in
// ir()'s own operand-width model (ONE_OPERAND covered CALL's siblings but not FPUSH/DPUSH's width,
// and TYPEMAP fell through the same default-zero-operand path) - so the disassembler desynced:
// an operand word got printed as a fresh, bogus "?<big-number>" instruction, and every real
// instruction after it shifted. This is the 4th independently-found instance of the DPUSH-2-word
// bug family this campaign has hit (native/pipeline.mjs, native/optimize.lm, native/emit_llvm.lm
// during D2/D3; this pair - compiler_core.mjs's ir() and seed/lumen_mcp.mjs's typesFromSource -
// during C0/this fix).
//
// This test renders the two conformance-corpus files that exercise it (decimal.lm: DPUSH-heavy;
// floats.lm: FPUSH-heavy, plus TYPEMAP records since typed functions always carry one) and checks
// the disassembly against an INDEPENDENTLY reimplemented reference walker over the same raw IR
// words - not just eyeballing the printed text - so a coincidental line-count match cannot mask a
// real desync, and a future regression in compiler_core.mjs's own table cannot silently agree
// with itself.
//
// Run: node ir_render_test.mjs

import fs from 'node:fs';
import { createCompiler, CODE_BASE } from './compiler_core.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); failures++; }
}

// Independent reference oplen, hand-verified against seed/lumenc.wat's own opcode dispatch -
// deliberately NOT imported from compiler_core.mjs (the whole point is to catch that file's own
// table being wrong, not assume it agrees with itself). The same three-bucket shape this campaign
// has now derived independently three times already (native/emit_llvm.lm for D3, seed/effects.mjs
// for C0, here for the 4th): CALL(8)/FPUSH(29)/DPUSH(64) take 2 operand words; PUSH/GETARG/JZ/JMP/
// RESERVE/SETLOCAL/MKTEXT/MKSUM take 1; everything else (including every Dec/bitwise/float/array
// op) takes 0 inline operand words (they consume the operand stack instead). TYPEMAP(57) is
// handled separately below - it is not a fixed-width opcode at all.
function refOplen(op) {
  if (op === 8 || op === 29 || op === 64) return 2;
  if ([1, 2, 6, 7, 13, 14, 15, 25].includes(op)) return 1;
  return 0;
}

// The TRUE shape a correct disassembly must have: one line per real instruction, one line per
// TYPEMAP record, walking the raw IR words directly (no reliance on ir()'s own text output).
function refWalk(words) {
  let pc = 0, instructionCount = 0, typemapCount = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { typemapCount++; pc += 3 + words[pc + 1]; continue; }
    instructionCount++;
    pc += 1 + refOplen(op);
  }
  return { instructionCount, typemapCount, totalLines: instructionCount + typemapCount };
}

const lumen = await createCompiler();

for (const file of ['../mu/examples/decimal.lm', '../mu/examples/floats.lm']) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const c = lumen.compile(src);
  check(c.ok, `${file}: compiles`);
  if (!c.ok) continue;

  const words = new Int32Array(lumen.exports.mem.buffer, CODE_BASE, c.irWords);
  const ref = refWalk(words);

  const r = lumen.ir(src);
  check(r.ok, `${file}: ir() reports ok`);
  const lines = r.text.split('\n').filter((l) => l.length > 0);

  check(
    lines.length === ref.totalLines,
    `${file}: disassembly line count matches the independent reference walk ` +
    `(got ${lines.length}, want ${ref.totalLines} = ${ref.instructionCount} instructions + ${ref.typemapCount} typemaps)`,
  );

  // No phantom opcodes: a genuine opcode is always in [0,70]. An operand word misread as a fresh
  // "instruction" is, in practice, a Dec micro-unit value or an IEEE-754 float half - always far
  // outside that range for any literal that isn't tiny (both files' literals qualify: decimal.lm's
  // smallest scaled magnitude is 1 (0.000001d), floats.lm's are all >= thousands once scaled).
  const phantoms = lines.filter((l) => {
    const m = l.match(/\?(\d+)/);
    return m && Number(m[1]) > 70;
  });
  check(phantoms.length === 0, `${file}: no phantom opcodes from misread operand words (found: ${JSON.stringify(phantoms)})`);

  // Every CALL/FPUSH/DPUSH line must show exactly the operand count the reference walker expects
  // (2 numbers after the opname), not 0 or 1 - the precise symptom of the original bug.
  for (const line of lines) {
    const m = line.match(/^\s*\d+\s+(CALL|FPUSH|DPUSH)\b(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    const operandCount = rest.length === 0 ? 0 : rest.split(/\s+/).filter((tok) => /-?\d+$/.test(tok.replace(/^\w+=/, ''))).length;
    check(operandCount === 2, `${file}: "${line.trim()}" carries exactly 2 operand numbers (got ${operandCount})`);
  }
}

console.log(failures === 0 ? '\nir_render_test: all checks passed.' : `\nir_render_test: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
