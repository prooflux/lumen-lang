// lumend_vs_cc_bench.mjs - head-to-head benchmark for the claim behind lumend_native.mjs: a warm
// Lumen native daemon compile can be faster than a cold system-compiler invocation.
//
// WHAT IS MEASURED (three legs, N=30 each, median reported):
//   (a) lumend_native.mjs warm-daemon `check` round trip (client -> Unix socket -> already-warm
//       resident native compiler -> back), for the same small representative program used by
//       lumend_native_test.mjs.
//   (b) `clang -O2` cold compile of a size-matched trivial C program (a fresh `clang` process per
//       run, exactly the "process spawn + compile" cost a developer actually pays when they type
//       `clang -O2 file.c`).
//   (c) `gcc -O2` cold compile of the SAME C program, IF a `gcc` binary exists on PATH.
//
// HONESTY NOTES (read before quoting these numbers anywhere):
//
// 1. gcc vs clang on this machine: Apple ships `/usr/bin/gcc` as a symlink/wrapper around Apple
//    clang (`gcc --version` and `clang --version` print the identical "Apple clang version ..."
//    banner). On macOS this benchmark's leg (c) is NOT a second, independent compiler - it is the
//    same clang binary invoked under a different argv[0]. This script still runs it (so the
//    numbers are real and reproducible), but the summary explicitly calls this out instead of
//    presenting two compiler names as if they were two implementations. On a Linux box with a
//    real GNU gcc this leg would be a genuine second data point.
//
// 2. This is NOT an apples-to-apples comparison of equivalent work, and no number below should be
//    read as "Lumen's compiler is Nx faster than clang's compiler" in the general sense:
//      - The daemon leg compiles Lumen source down to Lumen's own raw IR (diagnostics + word
//        count), fully in-memory over an already-warm resident process. No C is emitted, no
//        linker runs, no on-disk artifact is produced.
//      - The clang/gcc legs compile a trivial C program ALL THE WAY to a linked, on-disk Mach-O
//        executable (`-O2`, real optimizer passes, real linker invocation), from a cold process
//        spawned fresh for that one compile.
//    The comparison this benchmark actually substantiates is narrower and still real: "the
//    end-to-end latency a developer feels when asking the warm Lumen daemon to compile a small
//    program is lower than the end-to-end latency of a fresh `clang -O2` invocation on an
//    equivalently small C program" - a fair developer-experience comparison of two things people
//    actually wait on, NOT a claim that Lumen's IR-checking pass out-optimizes clang's backend.
//
// 3. Size-matched inputs: the Lumen program and the C program are chosen to be comparable in
//    scope (a `main` that does one trivial print of a constant), so neither side is padded or
//    starved relative to the other.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCK = path.join(os.tmpdir(), `lumen-native-bench-${process.pid}.sock`);
const DAEMON_PATH = path.join(__dirname, 'lumend_native.mjs');

const N = 30;

const LUMEN_SRC = 'fn main(c: Console) -> Unit { c.print_int(1) return () }';
// Size-matched trivial C program: one function, one call, one constant, same shape as LUMEN_SRC.
const C_SRC = '#include <stdio.h>\nint main(void) { printf("%d\\n", 1); return 0; }\n';

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function daemonRequest(req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCK);
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    sock.on('error', reject);
  });
}

function spawnDaemon() {
  return new Promise((resolve, reject) => {
    const child = fork(DAEMON_PATH, [SOCK], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let started = false;
    child.stderr.on('data', (chunk) => {
      if (!started && chunk.toString('utf8').includes('listening on')) { started = true; resolve(child); }
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (!started) reject(new Error(`daemon exited early (code=${code})`)); });
    setTimeout(() => { if (!started) reject(new Error('daemon did not report "listening on" within 15s')); }, 15000);
  });
}

function which(bin) {
  try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function ccVersionBanner(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8' }).split('\n')[0]; }
  catch { return null; }
}

function timeColdCCompile(bin, cSrcPath, outPath, tmpBase) {
  const times = [];
  for (let i = 0; i < N; i++) {
    const out = `${outPath}.${i}`;
    const t0 = process.hrtime.bigint();
    execFileSync(bin, ['-O2', cSrcPath, '-o', out], { stdio: 'ignore' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    try { fs.unlinkSync(out); } catch {}
  }
  return times;
}

async function main() {
  console.log('== lumend_native vs system C compilers: head-to-head developer-facing latency ==');
  console.log(`(N=${N} per leg, median reported; see file header for what is and is not being compared)\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-bench-'));
  const cSrcPath = path.join(tmpDir, 'trivial.c');
  fs.writeFileSync(cSrcPath, C_SRC);

  // --- (a) warm daemon ---
  const daemon = await spawnDaemon();
  let daemonTimes;
  try {
    await daemonRequest({ id: 0, op: 'check', src: LUMEN_SRC }); // settle client-side warm-up
    daemonTimes = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await daemonRequest({ id: 100 + i, op: 'check', src: LUMEN_SRC });
      daemonTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.on('exit', r));
  }
  const daemonMedian = median(daemonTimes);

  // --- (b) clang -O2 cold ---
  const clangBin = which('clang');
  let clangMedian = null, clangBanner = null;
  if (clangBin) {
    clangBanner = ccVersionBanner(clangBin);
    const clangTimes = timeColdCCompile(clangBin, cSrcPath, path.join(tmpDir, 'clang_out'));
    clangMedian = median(clangTimes);
  }

  // --- (c) gcc -O2 cold, if present ---
  const gccBin = which('gcc');
  let gccMedian = null, gccBanner = null, gccIsClang = false;
  if (gccBin) {
    gccBanner = ccVersionBanner(gccBin);
    gccIsClang = clangBanner !== null && gccBanner === clangBanner;
    const gccTimes = timeColdCCompile(gccBin, cSrcPath, path.join(tmpDir, 'gcc_out'));
    gccMedian = median(gccTimes);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`(a) lumend_native warm daemon (Lumen -> IR, check op):        median ${daemonMedian.toFixed(3)}ms  (N=${N})`);
  if (clangMedian !== null) {
    console.log(`(b) clang -O2 cold compile (C -> linked binary):              median ${clangMedian.toFixed(3)}ms  (N=${N})  [${clangBanner}]`);
    console.log(`    speedup vs clang cold: ${(clangMedian / daemonMedian).toFixed(1)}x`);
  } else {
    console.log('(b) clang: not found on PATH, skipped');
  }
  if (gccMedian !== null) {
    console.log(`(c) gcc -O2 cold compile (C -> linked binary):                median ${gccMedian.toFixed(3)}ms  (N=${N})  [${gccBanner}]`);
    console.log(`    speedup vs gcc cold: ${(gccMedian / daemonMedian).toFixed(1)}x`);
    if (gccIsClang) {
      console.log('    NOTE: on this machine /usr/bin/gcc IS Apple clang under a different argv[0]');
      console.log('    (identical --version banner) - this is NOT a second, independent compiler.');
      console.log('    Treat legs (b) and (c) as ONE data point on macOS, not two.');
    }
  } else {
    console.log('(c) gcc: not found on PATH, skipped');
  }

  console.log('\nMETHODOLOGY CAVEAT (see file header): the daemon leg checks Lumen source to raw IR');
  console.log('in-memory against an already-warm process; the C legs compile-and-link a full binary');
  console.log('from a cold process. This benchmark substantiates a developer-facing latency claim,');
  console.log('not an equal-work compiler-throughput claim.');
}

main().catch((err) => { console.error(err); process.exit(1); });
