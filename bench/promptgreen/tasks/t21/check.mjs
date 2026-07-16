import { createCompiler } from '/Users/freedom/lumen-source/lumen/seed/compiler_core.mjs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const arg = process.argv[2];
const source = fs.readFileSync(arg, 'utf8');
const compiler = await createCompiler();
const compiled = compiler.run(source);
console.log('compile ok:', compiled.ok, 'stdout:', JSON.stringify(compiled.stdout));

const hidden = await import(pathToFileURL('/private/tmp/claude-501/-Users-freedom-QUANTS/8bfbeb5f-e9c7-4c6e-ac25-bd073e98aa1e/scratchpad/corpus-factory/tasks/t21/hidden_tests.mjs').href);
const result = await hidden.run((src) => compiler.run(src), source);
console.log('hidden green:', result.green, JSON.stringify(result.detail));
