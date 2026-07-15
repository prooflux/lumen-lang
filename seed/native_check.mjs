// native_check.mjs - R3: a native-first, wasm-fallback drop-in for `lumen.compile(source)` at
// any host call site that only needs the compile step (diagnostics + IR word count), not
// run/interpret: seed/lumend.mjs's check/fix/ir ops, seed/lumen_mcp.mjs's in-process fallback
// paths, seed/lumen.mjs's check/fix/ir commands.
//
// `run` deliberately stays on the wasm interpreter everywhere (see each host, unchanged): native
// "running" a snippet means a fresh clang build per request, a fundamentally heavier operation
// than compiling to IR that would REGRESS latency for the hot interactive loop these hosts exist
// to serve (compiler_core.mjs's own header comment: "Compile is sub-millisecond"). The R3 brief
// is specifically about the COMPILE path; this file's scope matches that exactly.
//
// Env gate: LUMEN_COMPILE=wat forces the existing wasm-only path (lumen.compile(src) directly),
// the same convention native/pipeline.mjs's compileToIRAuto uses. Fallback is automatic and
// never silent: any native infra failure (oversized source, a dead/crashed resident process, a
// malformed wire response, or a structural self-check failure on the returned IR) falls back to
// lumen.compile(src) and prints a warning to stderr - never a silently wrong result.
import { checkNativeResident } from '../native/native_compile.mjs';
import { validateNativeIR } from '../native/pipeline.mjs';

// `lumen` is an already-created warm wasm compiler (seed/compiler_core.mjs's createCompiler()
// return value) - reused for the fallback so this never spins up a second wasm instance. Returns
// exactly lumen.compile(src)'s shape: { ok, irWords, main, srclen, rawDiags }.
export async function checkAuto(lumen, src) {
  if (process.env.LUMEN_COMPILE === 'wat') return lumen.compile(src);
  let r;
  try {
    r = await checkNativeResident(src);
  } catch (e) {
    process.stderr.write(`lumen: native check failed (${e.message}), falling back to wat\n`);
    return lumen.compile(src);
  }
  if (r.ok) {
    // Only validate the IR's own structure on the success path - a legitimate compile error
    // (r.ok === false) can leave a partial/incomplete IR by design, and validating it here would
    // spuriously trigger a fallback for a result that is already correct (wat would report the
    // identical error).
    const problem = validateNativeIR(r.words, r.main);
    if (problem) {
      process.stderr.write(`lumen: native check failed its structural self-check (${problem}), falling back to wat\n`);
      return lumen.compile(src);
    }
  }
  return { ok: r.ok, irWords: r.irWords, main: r.main, srclen: r.srclen, rawDiags: r.rawDiags };
}
