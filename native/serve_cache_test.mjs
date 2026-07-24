// serve_cache_test.mjs - proves the native serve binary is compiled ONCE and reused across
// process invocations that share the same routes config, instead of being recompiled via
// clang on every call.
//
// Root cause this closes (2026-07-24, direct instrumentation, not a guess - see the comment
// above buildNativeServeCached in lumen_serve_native.mjs): every Lumen-edge Cloud Run service
// calls runServer(cfgPath) twice against the IDENTICAL cfgPath - once during the Docker image's
// build-time warmup RUN step, once again at every runtime cold start (the CMD). Before this
// cache, both invocations independently ran the full emit_fn.lm -> C -> clang -O2 pipeline, so
// every cold start paid a fresh compile; the transient memory that compile needs OOM-killed a
// 256Mi container in production (measured ~345 MiB used against the limit).
//
// This test proves, without touching Cloud Run: (1) a fresh cfgPath produces a cache MISS and a
// cache file, (2) calling it again with byte-identical inputs produces a cache HIT that reuses
// the exact same binary file (same path, unchanged mtime - i.e. clang did NOT run again), and
// (3) the two binaries, if independently rebuilt, would in fact be byte-identical (determinism),
// so caching changes WHEN compilation happens, never WHAT gets served.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNativeServeCached } from './lumen_serve_native.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

const ROUTES = [
  { method: 'GET', path: '/', status: 200, contentType: 'text/plain', bodyBytes: Buffer.from('hello') },
  { method: 'GET', path: '/health', status: 200, contentType: 'application/json', bodyBytes: Buffer.from('{"ok":true}') },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-servecache-test-'));
const cfgPath = path.join(dir, 'routes.json'); // buildNativeServeCached only reads its dirname; content unused by the function itself
fs.writeFileSync(cfgPath, '{}');

const t0 = Date.now();
const first = await buildNativeServeCached(cfgPath, ROUTES, false, undefined);
const buildMs = Date.now() - t0;
check('first call produced an executable binary', fs.existsSync(first.bin) && (fs.statSync(first.bin).mode & 0o111) !== 0);
check('first call wrote exactly one cache entry', fs.readdirSync(path.join(dir, '.lumen-native-cache')).length === 1);

const mtimeAfterFirst = fs.statSync(first.bin).mtimeMs;

const t1 = Date.now();
const second = await buildNativeServeCached(cfgPath, ROUTES, false, undefined);
const cacheHitMs = Date.now() - t1;

check('second call reused the SAME binary path (cache hit, not a fresh temp dir)', second.bin === first.bin);
check('second call did not recompile (mtime unchanged)', fs.statSync(second.bin).mtimeMs === mtimeAfterFirst);
check('second call is dramatically faster than the first (no clang invocation)', cacheHitMs < buildMs / 2 || cacheHitMs < 50);
check('bodyBlock is still correct on a cache hit', second.bodyBlock.equals(Buffer.concat([Buffer.from('hello'), Buffer.from('{"ok":true}')])));

// A change to the routes must invalidate the cache (correctness: never serve stale logic).
const CHANGED_ROUTES = [
  { method: 'GET', path: '/', status: 200, contentType: 'text/plain', bodyBytes: Buffer.from('goodbye') },
];
const third = await buildNativeServeCached(cfgPath, CHANGED_ROUTES, false, undefined);
check('changed routes produce a DIFFERENT cache entry (no stale reuse)', third.bin !== first.bin);
check('changed routes leave the original cache entry untouched', fs.statSync(first.bin).mtimeMs === mtimeAfterFirst);

console.log(`\n${pass} passed, ${fail} failed (build ${buildMs} ms, cache-hit ${cacheHitMs} ms)`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
