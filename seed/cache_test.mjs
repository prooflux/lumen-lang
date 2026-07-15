// cache.mjs conformance: hit/miss/invalidation/bypass behavior.
// Usage: node cache_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cacheKey, withCache, CACHE_DIR_PATH } from './cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function reset() {
  fs.rmSync(CACHE_DIR_PATH, { recursive: true, force: true });
}

function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}\n  ${e.message}`); }
}

// (1) second check of identical source is a HIT: computeFn runs once, entry file exists after.
check('identical source hits the cache on the second call', () => {
  reset();
  const source = 'let x = 1;';
  let calls = 0;
  const compute = () => { calls++; return { value: 42 }; };

  const r1 = withCache('check', source, compute);
  assert.equal(calls, 1, 'first call must compute');
  const key = cacheKey(source, 'check');
  const file = path.join(CACHE_DIR_PATH, `${key}.json`);
  assert.ok(fs.existsSync(file), 'cache entry must be written to disk');

  const r2 = withCache('check', source, compute);
  assert.equal(calls, 1, 'second call must NOT recompute (cache hit)');
  assert.deepEqual(r2, r1, 'cached result must match original result');
});

// (2) changing one source byte MISSES: distinct cache key, distinct file, computeFn re-runs.
check('a one-byte source change misses the cache', () => {
  reset();
  const sourceA = 'let x = 1;';
  const sourceB = 'let x = 2;';
  let calls = 0;
  const compute = () => { calls++; return { value: calls }; };

  withCache('check', sourceA, compute);
  withCache('check', sourceB, compute);
  assert.equal(calls, 2, 'different source must recompute, not hit A\'s entry');
  assert.notEqual(cacheKey(sourceA, 'check'), cacheKey(sourceB, 'check'), 'keys must differ');
});

// (3) a compiler-identity change (native/lumenc.bootstrap.c content) invalidates cache entries.
// We do NOT touch the real bootstrap file; we replicate cacheKey's hashing logic on a mutated
// copy and assert the resulting key differs from the real one. (R5: the identity source moved
// from the retired seed/lumenc.wat to native/lumenc.bootstrap.c - see cache.mjs's header.)
check('a mutated compiler identity (native/lumenc.bootstrap.c content) changes the cache key', () => {
  const source = 'let x = 1;';
  const realBootstrapC = fs.readFileSync(path.join(HERE, '../native/lumenc.bootstrap.c'), 'utf8');
  const mutatedBootstrapC = realBootstrapC + '\n// simulated compiler change, never written to disk';

  const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
  const realKey = `${sha256(source)}-${sha256(realBootstrapC)}-check`;
  const mutatedKey = `${sha256(source)}-${sha256(mutatedBootstrapC)}-check`;

  assert.equal(realKey, cacheKey(source, 'check'), 'sanity: our replicated hash matches cacheKey');
  assert.notEqual(realKey, mutatedKey, 'a compiler-identity change must produce a different key');
});

// (4) LUMEN_NO_CACHE=1 skips writes entirely (and skips reads).
check('LUMEN_NO_CACHE=1 bypasses the cache (no write, no read, always recomputes)', () => {
  reset();
  const source = 'let x = 1;';
  let calls = 0;
  const compute = () => { calls++; return { value: calls }; };

  process.env.LUMEN_NO_CACHE = '1';
  try {
    withCache('check', source, compute);
    withCache('check', source, compute);
    assert.equal(calls, 2, 'both calls must recompute when caching is bypassed');
    const key = cacheKey(source, 'check');
    const file = path.join(CACHE_DIR_PATH, `${key}.json`);
    assert.ok(!fs.existsSync(file), 'no cache entry may be written while bypassed');
  } finally {
    delete process.env.LUMEN_NO_CACHE;
  }
});

reset();

if (failures > 0) {
  console.error(`\n${failures} cache test(s) failed.`);
  process.exit(1);
}
console.log('\nall cache tests passed.');
