// resident_sync.mjs - R5 ADDENDUM: a synchronous facade over the R3 resident compiler server,
// for seed/compiler_core.mjs's compile()/run()/ir() hot path. perf.mjs (and every other caller:
// lumen.mjs, lumen_mcp.mjs, basics.mjs, the selftest harnesses) calls lumen.compile() as a
// plain, non-awaited synchronous function returning a plain object - that external contract is
// load-bearing across the whole repo, so we cannot simply `await` the resident server's async
// wire protocol inside compile() without breaking every one of those call sites.
//
// Technique: a lazily-started worker_thread owns the resident child process (see
// resident_sync_worker.mjs - it gets its own fresh module registry, hence its own
// ResidentCompiler singleton) and answers one request at a time. The calling (main) thread
// blocks on Atomics.wait() on a shared Int32Array until the worker signals completion via
// Atomics.notify(), then drains the actual response with worker_threads.receiveMessageOnPort() -
// the documented Node pattern for synchronous cross-thread request/response (no polling loop, no
// extra OS process spawned per call once the bridge and its resident child are warm).
//
// Orphan safety: the resident child is a real OS child process, but it is owned by a pipe
// (stdin/stdout) whose write end lives inside THIS process (via the worker thread). When this
// process exits by any means - normal exit, SIGINT/SIGTERM, or a crash - the OS closes every fd
// this process holds, including that pipe; the resident binary's own read loop treats stdin EOF
// as its shutdown signal (see native/lumenc_native.mjs's lm_resident_loop: lm_compile_rd4()
// returns the EOF sentinel and the loop breaks, falling out of main). So even with NO explicit
// cleanup code, the child cannot outlive this process. stopResidentSyncBridge() below is the
// prompt, explicit version of that same shutdown (tests want it to take effect immediately,
// not "eventually, when the OS gets around to it").
//
// Failure mode: if the worker thread fails to start, or a request times out (SYNC_TIMEOUT_MS -
// generous, since a genuine compile is sub-millisecond once warm; this only guards a wedged or
// crashed worker), compileToIRResidentSync throws and the bridge marks itself permanently
// unavailable for the rest of this process (mirrors the rest of the codebase's "a broken
// resident path does not retry mid-process; a fresh process gets a fresh chance" convention -
// see native_compile.mjs's own getResidentCompiler() respawn-after-crash logic, which this
// bridge still benefits from on a FRESH worker, i.e. a fresh process). Callers
// (seed/compiler_core.mjs's compile()) catch this once, log it once, and fall back to the
// pre-existing one-shot spawn path (compileToIRNativeRaw) for every subsequent call.
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'resident_sync_worker.mjs');
const SYNC_TIMEOUT_MS = 10000;

let worker = null;
let workerPort = null;
let sync = null;      // Int32Array over a 4-byte SharedArrayBuffer; sync[0] flips 0->1 on response
let startErr = null;  // once set, the bridge is permanently unavailable for this process
let reqId = 0;

function ensureWorker() {
  if (worker || startErr) return;
  try {
    const sab = new SharedArrayBuffer(4);
    sync = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    workerPort = port1;
    const w = new Worker(WORKER_PATH, { workerData: { port: port2, sab }, transferList: [port2] });
    w.unref();   // never keep the process alive on the bridge's own account
    w.on('error', (e) => { startErr = e; worker = null; });
    worker = w;
  } catch (e) {
    startErr = e;
    worker = null;
  }
}

// Synchronously compile via the resident server. Returns compileToIRNativeRaw's exact shape
// ({ words, main, strings, nerr, rawDiags, tokens, symbols }), or throws (caller falls back).
export function compileToIRResidentSync(src) {
  ensureWorker();
  if (!worker) throw startErr || new Error('resident sync bridge: worker unavailable');
  const id = ++reqId;
  Atomics.store(sync, 0, 0);
  workerPort.postMessage({ id, src });
  const waitResult = Atomics.wait(sync, 0, 0, SYNC_TIMEOUT_MS);
  if (waitResult === 'timed-out') {
    startErr = new Error('resident sync bridge: timed out waiting for worker response');
    try { worker.terminate(); } catch { /* best effort */ }
    worker = null;
    throw startErr;
  }
  const msg = receiveMessageOnPort(workerPort);
  if (!msg) throw new Error('resident sync bridge: no message on port after notify');
  const { id: rid, error, result } = msg.message;
  if (rid !== id) throw new Error(`resident sync bridge: id mismatch (sent ${id}, got ${rid})`);
  if (error) throw new Error(error);
  return result;
}

// True once the bridge has been used successfully at least once and has not since broken -
// informational only (tests use it to assert the fast path is actually the one exercised).
export function isResidentSyncBroken() { return !!startErr; }

// Graceful, prompt shutdown (tests / explicit callers / process-exit hooks): ask the worker to
// stop its resident child, then let it go - a later call to compileToIRResidentSync respawns a
// brand new worker + resident child lazily.
export function stopResidentSyncBridge() {
  if (worker) {
    try { workerPort.postMessage({ shutdown: true }); } catch { /* already gone */ }
    try { worker.terminate(); } catch { /* already gone */ }
  }
  worker = null;
  workerPort = null;
  startErr = null;
}
