// resident_sync_worker.mjs - R5 ADDENDUM: the worker-thread side of resident_sync.mjs's
// synchronous facade over the R3 resident compiler server (native_compile.mjs's
// ResidentCompiler). This file's own top-level import of native_compile.mjs gets a FRESH module
// registry inside this worker thread (Node gives every worker_threads.Worker its own module
// cache), so the ResidentCompiler singleton it spawns here is entirely separate from any
// resident child a main-thread caller of native_compile.mjs might independently own (e.g.
// seed/lumend.mjs's direct checkNativeResident() calls) - each side owns and reuses exactly one
// resident child for its own lifetime, never spawning a fresh one per request.
import { parentPort, workerData } from 'node:worker_threads';
import { compileToIRNativeResidentFullRaw, stopResidentCompiler } from './native_compile.mjs';

const { port, sab } = workerData;
const sync = new Int32Array(sab);

function signal() {
  Atomics.store(sync, 0, 1);
  Atomics.notify(sync, 0);
}

port.on('message', async (msg) => {
  if (msg && msg.shutdown) {
    try { stopResidentCompiler(); } finally { signal(); process.exit(0); }
    return;
  }
  const { id, src } = msg;
  let response;
  try {
    const result = await compileToIRNativeResidentFullRaw(src);
    response = { id, result };
  } catch (e) {
    response = { id, error: String((e && e.message) || e) };
  }
  port.postMessage(response);
  signal();
});

// Belt-and-braces: if this worker's own event loop ends (terminate(), or the process itself
// exiting - fds close either way, see resident_sync.mjs's header comment on why the resident
// child cannot outlive this process regardless), release the resident child's stdin promptly
// rather than waiting on the OS to notice the pipe closed.
process.on('exit', () => { try { stopResidentCompiler(); } catch { /* best effort */ } });
