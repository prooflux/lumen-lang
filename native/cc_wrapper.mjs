// cc_wrapper.mjs - resolves the clang invocation used across the native/*.mjs build helpers.
//
// Every build helper in this directory (getNativeCompilerBin/getNativeEmitterBin/
// getNativeOptimizerBin in native_compile.mjs, buildNativeBinaryFromC in lumenc_native.mjs) shells
// out to `clang` directly, once per process, into a fresh mkdtemp directory. Across the CI gate
// suite (many separate node processes, several of which independently clang-build the SAME
// checked-in bootstrap C - native/lumenc.bootstrap.c, native/emit_fn.bootstrap.c,
// native/optimize.bootstrap.c - from scratch), that is a lot of redundant compilation of
// byte-identical source with zero cross-process cache.
//
// If `sccache` (https://github.com/mozilla/sccache) is on PATH, this wraps the clang invocation as
// `sccache clang ...`: sccache content-hashes the preprocessed source and caches the compiled
// object/binary, so repeat compiles of the same generated C (across separate node processes, even
// running concurrently) become cache hits instead of full clang runs. This is a complementary
// speedup to the resident-compiler-server work in native_compile.mjs's R3 section: that avoids
// repaying the LUMEN COMPILER's own process-spawn/interpretation cost; this avoids repaying
// CLANG's compile time for identical generated C.
//
// Falls back to plain, unwrapped `clang` if sccache is not installed - exact current behavior,
// verified once per process (cheap: a single --version probe) and cached after that.
import { execFileSync } from 'node:child_process';

let cached = null;

// Probe once per process whether sccache is usable. Never throws: any failure (not on PATH, not
// executable, errors out) falls back to plain clang.
function probeSccache() {
  try {
    execFileSync('sccache', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// { cmd, prefixArgs }: the command to execFileSync and any args that must precede the caller's
// own clang argv. cmd='clang', prefixArgs=[] when sccache is unavailable (the pre-existing,
// unwrapped invocation, byte-for-byte).
export function resolveCC() {
  if (cached) return cached;
  cached = probeSccache() ? { cmd: 'sccache', prefixArgs: ['clang'] } : { cmd: 'clang', prefixArgs: [] };
  return cached;
}

// Turn a plain `execFileSync('clang', clangArgs, opts)` call into the resolved invocation:
// `execFileSync(cmd, [...prefixArgs, ...clangArgs], opts)`. Callers replace their direct 'clang'
// execFileSync calls with this, unchanged otherwise (same argv content, same opts).
export function ccInvocation(clangArgs) {
  const { cmd, prefixArgs } = resolveCC();
  return { cmd, args: [...prefixArgs, ...clangArgs] };
}

// Reset the cached probe result (tests only - lets a test force a fresh probe).
export function _resetCCCacheForTests() { cached = null; }
