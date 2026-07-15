import fs from 'node:fs';
import { createCompiler } from '/Users/freedom/lumen-source/lumen/seed/compiler_core.mjs';
import { run as hiddenRun } from './hidden_tests.mjs';

const compiler = await createCompiler();
const target = process.argv[2];
const source = fs.readFileSync(target, 'utf8');
const result = await hiddenRun((src) => compiler.run(src), source);
console.log(JSON.stringify(result, null, 2));
