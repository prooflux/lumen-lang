#!/usr/bin/env node
// The Lumen CLI (stage-0). Compiles a Lumen-mu source file to IR and runs it.
//
//   node lumen.mjs run   <file.lm>    compile and run, print program output
//   node lumen.mjs check <file.lm>    compile only; report ok / number of IR words
//   node lumen.mjs ir    <file.lm>    print the compiled IR (one instruction per line)
//
// Requires wabt (a dev-only WAT assembler):  npm install   (once, in this directory)
import fs from 'node:fs';
import wabtInit from 'wabt';

const SRC_BASE = 20000;
const OPS = {0:'HALT',1:'PUSH',2:'GETARG',3:'ADD',4:'SUB',5:'LT',6:'JZ',7:'JMP',8:'CALL',
  9:'RET',10:'PRINTINT',11:'MUL',12:'DIV',13:'RESERVE',14:'SETLOCAL',15:'MKTEXT',
  16:'PRINTTEXT',17:'CONCAT',18:'INT2TEXT',19:'EQ',20:'NE',21:'LE',22:'GE',23:'GT',24:'MOD'};
const ONE_OPERAND = new Set([1,2,6,7,13,14,15]);

function usage() {
  console.error('usage: lumen <run|check|ir> <file.lm>');
  process.exit(2);
}

const [, , cmd, file] = process.argv;
if (!cmd || !file) usage();
if (!['run', 'check', 'ir'].includes(cmd)) usage();

let source;
try { source = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`lumen: cannot read ${file}: ${e.message}`); process.exit(1); }

const wabt = await wabtInit();
const wat = fs.readFileSync(new URL('./lumenc.wat', import.meta.url), 'utf8');
const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;

let out = '';
const { instance } = await WebAssembly.instantiate(binary, {
  lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
});

const bytes = Buffer.from(source, 'utf8');
new Uint8Array(instance.exports.mem.buffer, SRC_BASE, bytes.length).set(bytes);

// compile first, then report any errors before running
const irWords = instance.exports.compile(bytes.length);
const nerr = instance.exports.dbg_nerr();
if (nerr > 0) {
  const mem = new Uint8Array(instance.exports.mem.buffer);
  const recs = new Int32Array(instance.exports.mem.buffer, 90000, nerr * 3);
  for (let k = 0; k < nerr; k++) {
    const code = recs[k * 3], off = recs[k * 3 + 1], len = recs[k * 3 + 2];
    const name = Buffer.from(mem.slice(off, off + len)).toString('utf8');
    const so = off - SRC_BASE;                          // byte offset into source
    let line = 1, col = 1;
    for (let j = 0; j < so && j < bytes.length; j++) { if (bytes[j] === 10) { line++; col = 1; } else col++; }
    const what = code === 1 ? 'unknown variable' : code === 2 ? 'unknown function' : 'error';
    console.error(`${file}:${line}:${col}: error: ${what} '${name}'`);
  }
  console.error(`lumen: ${nerr} error(s); not run.`);
  process.exit(1);
}

if (cmd === 'check') {
  console.log(`ok: compiled ${file} (${irWords} IR words, main at ${instance.exports.dbg_main()})`);
  process.exit(0);
}

if (cmd === 'ir') {
  const code = new Int32Array(instance.exports.mem.buffer, 11328, irWords);
  let i = 0;
  while (i < irWords) {
    const op = code[i];
    let s = String(i).padStart(4) + '  ' + (OPS[op] || `?${op}`);
    if (op === 8) { s += `  entry=${code[i + 1]} argc=${code[i + 2]}`; i += 3; }
    else if (ONE_OPERAND.has(op)) { s += `  ${code[i + 1]}`; i += 2; }
    else { i += 1; }
    console.log(s);
  }
  process.exit(0);
}

// cmd === 'run' (compilation already succeeded above)
instance.exports.run(instance.exports.dbg_main());
process.stdout.write(out);
