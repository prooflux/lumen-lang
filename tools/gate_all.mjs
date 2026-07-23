// gate_all.mjs - run the EXACT sequence .github/workflows/gate.yml runs, locally, in one command.
//
// Why this exists (2026-07-23): a real regression (text_eq's return type changed from Int to
// Bool, breaking examples/http/handlers_demo.lm's `== 1` comparison) landed on main and sat there
// with a red `gate` check for several commits, because every agent working this repo that day
// hand-remembered a "full gate suite" from memory - a ~11-script subset - instead of running what
// gate.yml actually runs (5 jobs, ~50 scripts). native_handlers_test.mjs, the one gate that would
// have caught it, was never in anyone's list. This script is the fix: it IS gate.yml, transcribed
// mechanically into one runnable command, so "did I run the full gate suite" stops being a memory
// exercise. If gate.yml changes, update GATE_STEPS below to match - a drift check comparing the
// two is a reasonable follow-up but is not implemented here; keep this file's step list
// side-by-side with gate.yml when editing either.
//
// Usage:
//   node tools/gate_all.mjs            # --full (default): every job gate.yml runs, in order
//   node tools/gate_all.mjs --quick    # a fast, NON-CI-equivalent subset for low-risk changes
//                                       # (docs-only, new standalone files): seed npm test +
//                                       # native_diff.mjs + native_fixpoint_test.mjs (the one
//                                       # gate that must never silently break). This is a local
//                                       # sanity net, not a substitute for the real `gate` check -
//                                       # branch protection on main requires that to pass
//                                       # regardless of what you ran locally.
//   node tools/gate_all.mjs --install  # force `npm install` in seed/ and native/ first (slower;
//                                       # default assumes deps are already installed, since this
//                                       # is usually rerun many times per session)
//   node tools/gate_all.mjs --no-lock  # skip the concurrency guard (see below)
//
// Concurrency guard: this machine hit real, repeated slowdowns (2026-07-22/23) from several
// agents independently running full native rebuilds at once, contending for CPU badly enough to
// make gates that normally take seconds take 25-60+ minutes, and to make some node processes sit
// alive for 10+ minutes after printing a correct PASS summary (an OS-level process-teardown stall
// under memory pressure, confirmed reproducible). This script writes an advisory lockfile and
// warns (or refuses, with --no-lock to override) if another gate_all run already holds it, rather
// than silently piling on and making both runs slow. This is advisory only, not a hard mutex: it
// cannot stop a bare `node native_fixpoint_test.mjs` invocation from contending too.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const mode = args.includes('--quick') ? 'quick' : 'full';
const doInstall = args.includes('--install');
const noLock = args.includes('--no-lock');

const LOCK_PATH = path.join(os.tmpdir(), 'lumen-gate-all.lock');

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  if (noLock) return () => {};
  if (fs.existsSync(LOCK_PATH)) {
    const held = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (pidIsAlive(held.pid)) {
      const ageMin = ((Date.now() - held.startedAt) / 60000).toFixed(1);
      console.error(
        `\ngate_all: another gate_all run (pid ${held.pid}) has held the lock for ${ageMin} min.\n` +
        `Running concurrently on this machine has repeatedly caused 5-10x slowdowns from CPU\n` +
        `contention this session. Either wait for it to finish, or pass --no-lock if you are\n` +
        `certain this is a stale lock (a crashed prior run) or you accept the contention risk.\n`
      );
      process.exit(2);
    }
    // Stale lock (holder pid is gone): fall through and overwrite it.
  }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return () => {
    try {
      const cur = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(LOCK_PATH);
    } catch {
      // Already gone or unreadable - nothing more to do.
    }
  };
}

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

// Run `cmd` in `cwd`, streaming output live (stdio: 'inherit') so a long gate's progress is
// visible rather than a silent multi-minute black box - the exact thing that led several agents
// this session to assume a slow-but-real gate had hung and hand off to a background wait instead
// of just blocking on it. Returns true on exit code 0.
function run(cmd, cwd) {
  console.log(`\n$ ${cmd}   (cwd: ${path.relative(REPO, cwd) || '.'})`);
  const started = Date.now();
  const r = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit' });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`\nFAILED (exit ${r.status}, ${secs}s): ${cmd}`);
    return false;
  }
  console.log(`ok (${secs}s)`);
  return true;
}

const ROOT = REPO;
const SEED = path.join(REPO, 'seed');
const NATIVE = path.join(REPO, 'native');

// The native-gates script list, exactly as it appears in .github/workflows/gate.yml's
// "native gates" step, in the same order. Keep this list byte-for-byte in sync with that file.
const NATIVE_SCRIPTS = [
  'optimize_diff.mjs', 'native_diff.mjs', 'rawmem_diff.mjs', 'native_fn_test.mjs',
  'native_float_test.mjs', 'native_decimal_test.mjs', 'native_buffered_stdout_test.mjs',
  'llvm_diff.mjs', 'llvm_float_test.mjs', 'llvm_decimal_test.mjs', 'decimal_oracle_test.mjs',
  'standalone_diff.mjs', 'heapcap_test.mjs', 'fixpoint_emit_test.mjs', 'native_compile_test.mjs',
  'native_pipeline_test.mjs', 'native_fixpoint_test.mjs', 'bootstrap_test.mjs',
  'emitter_bootstrap_test.mjs', 'parity_corpus_test.mjs', 'selfcompile_diff.mjs',
  'arm64_spike_check.mjs', 'state_eventlog_test.mjs', 'analytics_events_test.mjs',
  'native_handlers_test.mjs', 'native_socket_test.mjs', 'fuel_test.mjs', 'tenant_routing_test.mjs',
  'http_parse_test.mjs', 'http_headers_test.mjs', 'http_response_test.mjs', 'url_decode_test.mjs',
  'http_chunked_test.mjs', 'http_request_body_test.mjs', 'http_router_test.mjs',
  'query_parse_test.mjs', 'http_status_line_test.mjs', 'hex_encode_test.mjs',
  'hex_decode_test.mjs', 'int_parse_test.mjs', 'trim_test.mjs', 'to_lower_test.mjs',
  'http_keepalive_test.mjs', 'content_type_value_test.mjs', 'http_serve_test.mjs',
];

const QUICK_STEPS = [
  { title: 'seed gates (quick: npm test only)', run: () => run('npm test', SEED) },
  { title: 'native: native_diff.mjs', run: () => run('node native_diff.mjs', NATIVE) },
  { title: 'native: native_fixpoint_test.mjs (the fixpoint - never allowed to break)',
    run: () => run('node native_fixpoint_test.mjs', NATIVE) },
];

function fullSteps() {
  const steps = [];
  if (doInstall) {
    steps.push({ title: 'install: seed/', run: () => run('npm install', SEED) });
    steps.push({ title: 'install: native/', run: () => run('npm install', NATIVE) });
  }
  steps.push({
    title: 'scoreboard gate (bench/scoreboard.json schema, evidence, flip-coupling)',
    run: () => run('node tools/scoreboard_gate_test.mjs && node tools/scoreboard_gate.mjs --check', ROOT),
  });
  steps.push({
    title: 'seed gates (conformance + safety + loop + cache)',
    run: () => run('npm test', SEED),
  });
  steps.push({
    title: 'C0: capability-purity ratchet (effects_gate)',
    run: () => run('node ../tools/effects_gate_test.mjs && node ../tools/effects_gate.mjs', SEED),
  });
  steps.push({
    title: `native gates (bit-identity vs the interpreter oracle) - ${NATIVE_SCRIPTS.length} scripts`,
    run: () => run(NATIVE_SCRIPTS.map((s) => `node ${s}`).join(' && '), NATIVE),
  });
  steps.push({
    title: 'native: lumen_serve_native.mjs --selftest',
    run: () => run('node lumen_serve_native.mjs --selftest', NATIVE),
  });
  steps.push({
    title: 'promptgreen rig selftest',
    run: () => run(
      'node bench/promptgreen/selftest.mjs && node bench/kernel_suite_selftest.mjs && node bench/latency_shootout_selftest.mjs',
      ROOT,
    ),
  });
  steps.push({
    title: 'absorb gate (foreign-oracle kernels stay pinned and green)',
    run: () => run('node tools/absorb/absorb_selftest.mjs && node tools/absorb/absorb_gate.mjs', ROOT),
  });
  return steps;
}

async function main() {
  const release = acquireLock();
  try {
    console.log(`gate_all.mjs: mode=${mode}${doInstall ? ' --install' : ''}${noLock ? ' --no-lock' : ''}`);
    if (mode === 'quick') {
      console.log(
        'NOTE: --quick is a fast local sanity net, NOT equivalent to the real `gate` CI check.\n' +
        'Branch protection on main requires the actual `gate` GitHub Actions check to pass\n' +
        'regardless of what runs locally. Use --full before opening a PR you expect to merge\n' +
        'without extra scrutiny.'
      );
    }
    const steps = mode === 'quick' ? QUICK_STEPS : fullSteps();
    const startedAll = Date.now();
    for (const step of steps) {
      section(step.title);
      const ok = step.run();
      if (!ok) {
        console.error(`\ngate_all: FAILED at "${step.title}". Stopping (fail-fast, matches CI).`);
        process.exitCode = 1;
        return;
      }
    }
    const mins = ((Date.now() - startedAll) / 60000).toFixed(1);
    console.log(`\nALL GATES PASSED (${mode}, ${mins} min).`);
  } finally {
    release();
  }
}

main();
