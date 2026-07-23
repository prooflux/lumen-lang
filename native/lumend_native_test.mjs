// lumend_native_test.mjs - proof gate for native/lumend_native.mjs (the persistent native
// compiler daemon): repeated compiles against the WARM DAEMON over its Unix socket must be
// faster than repeated COLD process spawns of the same native compiler binary, and the daemon's
// answers must agree byte-for-byte with the in-process resident compiler (checkNativeResident /
// compileToIRNativeResidentFullRaw) it wraps - the daemon is a transport change, not a new
// compiler.
//
// Fair-comparison framing (see this file's task brief / lumend_native.mjs's header): a cold
// gcc/clang invocation also pays process-startup cost, so the honest floor this daemon must beat
// is repeated ONE-SHOT spawns of the SAME native compiler binary (compileToIRNativeRaw, R2's
// pre-existing path - a fresh process per compile), not some idealized zero-cost baseline.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNativeResident, compileToIRNativeRaw, stopResidentCompiler } from './native_compile.mjs';
import { buildDiagnostics } from '../seed/diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOCK = path.join(os.tmpdir(), `lumen-native-test-${process.pid}.sock`);
const DAEMON_PATH = path.join(__dirname, 'lumend_native.mjs');

const SRC = 'fn main(c: Console) -> Unit { c.print_int(1) return () }';
const N = 30;

let fail = 0;
function check(cond, label) {
  if (cond) { console.log(`PASS  ${label}`); } else { console.log(`FAIL  ${label}`); fail++; }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// One newline-delimited-JSON round trip to the daemon over a fresh connection - mirrors how an
// external CLI process (a genuinely separate `node` invocation, not a shared in-process client)
// would talk to it, since that separateness is the whole point of the comparison.
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

async function main() {
  console.log('== native daemon: correctness (matches in-process resident compiler byte-for-byte) ==');
  const daemon = await spawnDaemon();
  try {
    const ping = await daemonRequest({ id: 1, op: 'ping' });
    check(ping.pong === true && typeof ping.warmMs === 'number', `ping -> ${JSON.stringify(ping)}`);

    const daemonCheck = await daemonRequest({ id: 2, op: 'check', src: SRC });
    const oracleCheck = await checkNativeResident(SRC);
    const oracleDiags = buildDiagnostics(oracleCheck.rawDiags, SRC);
    check(daemonCheck.ok === true && daemonCheck.ok === (oracleDiags.length === 0)
      && daemonCheck.irWords === oracleCheck.irWords,
      `check op agrees with checkNativeResident: irWords=${daemonCheck.irWords}`);

    const ERR_SRC = 'fn main(c: Console) -> Unit { c.print_int(undefined_var) return () }';
    const daemonErr = await daemonRequest({ id: 3, op: 'check', src: ERR_SRC });
    check(daemonErr.ok === false && daemonErr.diagnostics.length === 1 && daemonErr.diagnostics[0].code === 'E0001',
      `check op surfaces a real compile error: ${JSON.stringify(daemonErr.diagnostics)}`);

    const daemonCompile = await daemonRequest({ id: 4, op: 'compile', src: SRC });
    check(daemonCompile.ok === true && daemonCompile.nerr === 0 && daemonCompile.wordCount === oracleCheck.irWords
      && daemonCompile.main === oracleCheck.main,
      `compile op agrees with checkNativeResident: wordCount=${daemonCompile.wordCount}, main=f${daemonCompile.main}`);

    // --- Speed: warm daemon (socket round trip to an already-warm resident compiler) vs
    // repeated cold one-shot process spawns of the SAME native compiler binary. ---
    console.log(`\n== Speed: N=${N} compiles, warm daemon (socket) vs cold one-shot process spawn ==`);
    // Warm-up round for the daemon path only - a fresh daemon still needs its OWN first request
    // to settle any JIT/lazy-init cost inside this test's own client code (the daemon process
    // itself already warmed its resident compiler before it started listening).
    await daemonRequest({ id: 0, op: 'check', src: SRC });

    const daemonTimes = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await daemonRequest({ id: 100 + i, op: 'check', src: SRC });
      daemonTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const coldTimes = [];
    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      compileToIRNativeRaw(SRC);   // execFileSync: a fresh OS process per call, R2's cold path
      coldTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const daemonMedian = median(daemonTimes);
    const coldMedian = median(coldTimes);
    console.log(`daemon (warm, over socket):  median ${daemonMedian.toFixed(3)}ms`);
    console.log(`cold one-shot process spawn: median ${coldMedian.toFixed(3)}ms`);
    console.log(`speedup: ${(coldMedian / daemonMedian).toFixed(1)}x`);
    check(daemonMedian < coldMedian, `warm daemon beats repeated cold process spawns of the native binary (${daemonMedian.toFixed(3)}ms < ${coldMedian.toFixed(3)}ms)`);
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.on('exit', r));
  }

  stopResidentCompiler();
  console.log(`\nSummary: ${fail === 0 ? 'all checks passed' : fail + ' check(s) FAILED'}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
