// Content-addressed compile/run cache for the Lumen toolchain.
//
// Lumen is deterministic (no I/O beyond console, no time/random), so for a given source
// and a given compiler build, `check`/`ir`/`run` output is pure. We key cache entries on
// sha256(source) + sha256(compiler identity) + kind, so any compiler change invalidates every
// cached entry automatically. Set LUMEN_NO_CACHE=1 to bypass entirely (no reads, no writes) --
// useful for benchmarking or debugging cache bugs.
//
// R5: the compiler identity source is native/lumenc.bootstrap.c (the checked-in, reproducible C
// the native compiler binary is built from - see native/native_compile.mjs's
// getNativeCompilerBin()), not the retired seed/lumenc.wat. Same semantics as before: this file
// changes exactly when the compiler's behavior can change (bootstrap_test.mjs's rot guard keeps
// it in sync with lumenc.lm/emit_fn.lm), so it is an equally faithful invalidation trigger.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, '.lumen-cache');
const COMPILER_IDENTITY_PATH = path.join(HERE, '../native/lumenc.bootstrap.c');

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function compilerIdentityHash() {
  // Read fresh each call: cheap (single stat+read) and keeps the identity hash correct
  // even if the compiler is rebuilt between calls within a long-lived process (lumend/mcp).
  const bootstrapC = fs.readFileSync(COMPILER_IDENTITY_PATH, 'utf8');
  return sha256(bootstrapC);
}

export function cacheKey(source, kind) {
  return `${sha256(source)}-${compilerIdentityHash()}-${kind}`;
}

function entryPath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

function noCache() {
  return process.env.LUMEN_NO_CACHE === '1';
}

// withCache(kind, source, computeFn): returns computeFn()'s result, transparently cached
// on disk keyed by (source, compiler identity, kind). computeFn's result must be JSON-serializable.
export function withCache(kind, source, computeFn) {
  if (noCache()) return computeFn();

  const key = cacheKey(source, kind);
  const file = entryPath(key);

  try {
    const cached = fs.readFileSync(file, 'utf8');
    return JSON.parse(cached);
  } catch {
    // miss (missing file, unreadable, or corrupt JSON) -- fall through to compute
  }

  const result = computeFn();

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result));
  } catch {
    // best-effort: a write failure (e.g. read-only fs) must not break compilation
  }

  return result;
}

// withCacheAsync(kind, source, computeFn): the same contract as withCache above, for a
// computeFn that returns a Promise (R3: checkAuto/compileToIRAuto are async - they may await a
// resident-server round-trip). withCache() itself stays synchronous and unchanged for its
// existing callers (cache_test.mjs); this is purely additive, sharing the same key/read/write
// logic so the two never drift.
export async function withCacheAsync(kind, source, computeFn) {
  if (noCache()) return computeFn();

  const key = cacheKey(source, kind);
  const file = entryPath(key);

  try {
    const cached = fs.readFileSync(file, 'utf8');
    return JSON.parse(cached);
  } catch {
    // miss (missing file, unreadable, or corrupt JSON) -- fall through to compute
  }

  const result = await computeFn();

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result));
  } catch {
    // best-effort: a write failure (e.g. read-only fs) must not break compilation
  }

  return result;
}

export const CACHE_DIR_PATH = CACHE_DIR;
