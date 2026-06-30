// optimize_diff.mjs - the gate for the Lumen optimizer (point 2).
// Correctness (RULES rule 5): for every program, interpret(optimize(IR)) === interpret(IR),
// byte-for-byte. The optimizer is enabled only when this holds. The measured "changed" count
// is the justification (it must do something on programs with jump chains). Scalar/control/calls
// subset (runIR executes raw IR without a heap-init pass).
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIR, optimizeIR, runIR } from './pipeline.mjs';

const SCALAR = ['fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'];
const lumen = await createCompiler();
let pass = 0, fail = 0, totalChanged = 0;

for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`SKIP  ${name}`); continue; }
  const { words, main } = await compileToIR(src);
  const { words: opt, changed } = await optimizeIR(words, main);
  totalChanged += changed;
  // property: length preserved (jump-threading is length-preserving)
  const lenOk = opt.length === words.length;
  const out = await runIR(opt, main);
  const ok = out === ref.stdout && lenOk;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} threaded=${changed}  out=${JSON.stringify(out)}  ref=${JSON.stringify(ref.stdout)}${lenOk ? '' : '  LENGTH-CHANGED!'}`);
  if (ok) pass++; else fail++;
}

// synthetic jump-chain: PUSH 7; JMP L4; L4: JMP L6; L6: PRINTINT; HALT  -> threads JMP@2 to L6
// words:  0:PUSH 7 | 2:JMP 4 | 4:JMP 6 | 6:PRINTINT | 7:HALT
const chain = Int32Array.from([1, 7, 7, 4, 7, 6, 10, 0]);
const before = await runIR(Int32Array.from(chain), 0);
const { words: opt, changed } = await optimizeIR(Int32Array.from(chain), 0);
const after = await runIR(opt, 0);
const threadedRight = opt[3] === 6;            // JMP@2's target rewritten 4 -> 6 (the chain terminus)
const synthOk = before === '7\n' && after === '7\n' && changed >= 1 && threadedRight && opt.length === chain.length;
console.log(`${synthOk ? 'PASS' : 'FAIL'}  synthetic-jump-chain  threaded=${changed}  JMP@2 target ${chain[3]}->${opt[3]}  out=${JSON.stringify(after)}`);
if (synthOk) pass++; else fail++;

console.log(`\n${pass}/${SCALAR.length + 1} checks: optimize.lm (Lumen) is output-identical to the interpreter; ${totalChanged + changed} jump(s) threaded total (fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
