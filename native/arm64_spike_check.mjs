// DISPOSABLE SCAFFOLD (spike-only): builds mu/examples/add.lm through the arm64 spike
// path (IR -> emit_arm64_spike.lm -> .s -> as -> ld -> run), and compares its stdout
// byte-for-byte against the interpreter oracle (runIR). No clang, no C, anywhere in
// this path: as/ld act as assembler and linker only, per the lane brief.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileToIR, emitWith, runIR } from './pipeline.mjs';

async function main() {
  const src = fs.readFileSync(new URL('../mu/examples/add.lm', import.meta.url), 'utf8');
  const emitterSrc = fs.readFileSync(new URL('./emit_arm64_spike.lm', import.meta.url), 'utf8');

  const ir = await compileToIR(src);
  const oracleOut = await runIR(ir.words, ir.main);

  const asmText = await emitWith(emitterSrc, ir.words, ir.main);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-arm64-spike-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const sfile = path.join(dir, 'p.s');
  const ofile = path.join(dir, 'p.o');
  const bin = path.join(dir, 'p');
  fs.writeFileSync(sfile, asmText);

  const sdkroot = execFileSync('xcrun', ['--show-sdk-path']).toString().trim();
  try {
    execFileSync('as', ['-o', ofile, sfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error('ASSEMBLE FAILED');
    console.error(String(e.stderr || e.message));
    process.exit(1);
  }
  try {
    execFileSync('ld', ['-o', bin, ofile, '-lSystem', '-syslibroot', sdkroot], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error('LINK FAILED');
    console.error(String(e.stderr || e.message));
    process.exit(1);
  }

  let nativeOut;
  try {
    nativeOut = execFileSync(bin, [], { encoding: 'utf8' });
  } catch (e) {
    console.error('RUN FAILED');
    console.error(String(e.stdout || '') + String(e.stderr || e.message));
    process.exit(1);
  }

  console.log('oracle stdout :', JSON.stringify(oracleOut));
  console.log('native stdout :', JSON.stringify(nativeOut));

  if (nativeOut === oracleOut) {
    console.log('MATCH: arm64 spike stdout equals interpreter oracle byte for byte.');
    process.exit(0);
  } else {
    console.log('MISMATCH');
    process.exit(1);
  }
}

main();
