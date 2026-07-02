#!/usr/bin/env node
// Validity gate for genprog.mjs. Generates seeds 1..500, compiles each with a single
// warm compiler instance, and requires: every seed compiles clean (nerr==0/ok), seed 42
// generated twice is byte-identical, and at least 400/500 programs are unique.

import crypto from 'node:crypto';
import { createCompiler } from '../seed/compiler_core.mjs';
import { generateProgram } from './genprog.mjs';

async function main() {
  const compiler = await createCompiler();

  // determinism check: seed 42 twice
  const a = generateProgram(42);
  const b = generateProgram(42);
  if (a !== b) {
    console.error('DETERMINISM FAILURE: seed 42 produced different output on two calls');
    console.error('--- run 1 ---\n' + a);
    console.error('--- run 2 ---\n' + b);
    process.exit(1);
  }

  const hashes = new Set();
  let validCount = 0;

  for (let seed = 1; seed <= 500; seed++) {
    const src = generateProgram(seed);
    const h = crypto.createHash('sha256').update(src).digest('hex');
    hashes.add(h);

    const result = compiler.compile(src);
    const nerr = result.rawDiags ? result.rawDiags.length : (result.ok ? 0 : 1);
    if (!result.ok || nerr > 0) {
      console.error(`FAILURE at seed ${seed}: compile produced ${nerr} diagnostic(s)`);
      console.error('--- program ---');
      console.error(src);
      console.error('--- diagnostics ---');
      console.error(JSON.stringify(result.rawDiags, null, 2));
      if (result.crash) console.error('crash: ' + result.crash);
      process.exit(1);
    }
    validCount++;
  }

  const unique = hashes.size;
  if (unique < 400) {
    console.error(`FAILURE: only ${unique} unique programs out of 500 (need >= 400)`);
    process.exit(1);
  }

  console.log(`gen: ${validCount}/500 valid, ${unique} unique, deterministic`);
}

main().catch((e) => {
  console.error('FATAL: ' + (e.stack || e));
  process.exit(1);
});
