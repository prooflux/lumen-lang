// native_check.mjs - a native-resident-first, native-one-shot-fallback drop-in for
// `lumen.compile(source)` at any host call site that only needs the compile step (diagnostics +
// IR word count), not run/interpret: seed/lumend.mjs's check/fix/ir ops, seed/lumen_mcp.mjs's
// in-process fallback paths, seed/lumen.mjs's check/fix/ir commands.
//
// R5: both sides of this are now zero-wasm (there is no wat left to fall back to). The resident
// server (native/native_compile.mjs's checkNativeResident) is the fast path - warm, no per-call
// process spawn, the one this exists to serve. The fallback is `lumen.compile(src)`
// (seed/compiler_core.mjs, the one-shot native compiler: a process spawn per call, ~2ms, slower
// but simpler and always available) for genuine infra failures only - a dead/crashed resident
// process, a malformed wire response, an oversized source, or a structural self-check failure on
// the returned IR. A legitimate compile error (nerr > 0) is NOT a fallback trigger: the one-shot
// path would report the identical error, just at the cost of compiling twice.
import { checkNativeResident } from '../native/native_compile.mjs';
import { validateNativeIR } from '../native/pipeline.mjs';

// `lumen` is an already-created warm compiler (seed/compiler_core.mjs's createCompiler() return
// value) - reused for the fallback so this never pays a second cold-start. Returns exactly
// lumen.compile(src)'s shape: { ok, irWords, main, srclen, rawDiags }.
export async function checkAuto(lumen, src) {
  let r;
  try {
    r = await checkNativeResident(src);
  } catch (e) {
    process.stderr.write(`lumen: resident check failed (${e.message}), falling back to one-shot native compile\n`);
    return lumen.compile(src);
  }
  if (r.ok) {
    // Only validate the IR's own structure on the success path - a legitimate compile error
    // (r.ok === false) can leave a partial/incomplete IR by design, and validating it here would
    // spuriously trigger a fallback for a result that is already correct (the one-shot path
    // would report the identical error).
    const problem = validateNativeIR(r.words, r.main);
    if (problem) {
      process.stderr.write(`lumen: resident check failed its structural self-check (${problem}), falling back to one-shot native compile\n`);
      return lumen.compile(src);
    }
  }
  return { ok: r.ok, irWords: r.irWords, main: r.main, srclen: r.srclen, rawDiags: r.rawDiags };
}
