import { CODE_BASE } from './compiler_core.mjs';

// effects.mjs (C0) - per-function derived capability rows, via a direct-call-graph closure over
// the already-compiled IR. This is a PRACTICAL, RETROFITTED analysis, deliberately built ahead of
// the real capability type system (W2 Capabilities v1, docs/spec/LAMBDA_CAP.md): Lumen-mu today
// has exactly one capability (`Console`, a struct-like type threaded as an ordinary parameter,
// per docs/spec/LUMEN_MU.md section 1), no `use`/`handle` forms, and no effect rows in the type
// checker. What this file computes instead is an OBSERVATIONAL approximation: for every function,
// which capability kinds does it (transitively) touch, derived purely from which primitive
// capability-op(s) its body executes, directly or via a function it calls.
//
// Soundness (why a direct-call graph is enough, no points-to/alias analysis needed): Lumen-mu has
// no first-class functions (docs/spec/LUMEN_MU.md, "Out" list) - every CALL (op 8) target is
// resolved at compile time to a fixed function entry by the seed's own $resolve_fixups, so the
// call graph built here is EXACT, not an approximation of one. This soundness argument breaks the
// moment first-class functions/closures land; this file's docstring is the trip-wire comment for
// whoever adds them.
//
// Registry: a capability kind name -> the set of IR opcodes that directly perform it. Today this
// has exactly one entry (Console: PRINTINT=10, PRINTTEXT=16, per compiler_core.mjs's OPS table -
// the only two opcodes seed/lumenc.wat treats as a "use" against the primordial Console handler).
// Extend this map, not the algorithm, when W2 lands new capability-carrying opcodes (Clock,
// Random, FileSystem, Env, ...) - each is expected to arrive as its own dedicated opcode, exactly
// how every other Lumen-mu builtin already does (see D1's DPUSH/DFROMI/DADD/... for the precedent).
export const CAPABILITY_REGISTRY = {
  Console: new Set([10, 16]),   // PRINTINT, PRINTTEXT
};

// IR layout constants shared with compiler_core.mjs (CODE_BASE) and lumen_mcp.mjs's own
// symbolsFromSource (the [150000,157000) symbol table, 12 bytes/entry: name_off:i32, name_len:i32,
// entry:i32 - "entry" is the position of the function's own RESERVE/op-13 header word, the same
// value CALL's first operand resolves to after $resolve_fixups; see effects_test.mjs for the
// cross-check that a symbol's `entry` always lands on a real op-13 boundary this file finds).
const SYM_BASE = 150000;
const SYM_END = 157000;
const SYM_ENTRY_BYTES = 12;
const SRC_BASE = 100000;
const SRC_END = 150000;

// Operand-word counts. DELIBERATELY NOT the same object as compiler_core.mjs's ONE_OPERAND / any
// of the several near-duplicates elsewhere in this repo (native/pipeline.mjs pre-D2, native/
// optimize.lm pre-D2, native/emit_llvm.lm pre-D3, seed/lumen_mcp.mjs's typesFromSource/ir() as of
// this writing) that were each missing DPUSH(64)'s 2-word immediate at one point or another - see
// this file's own PR description for the running list. Writing this table fresh, once, correctly,
// rather than importing a maybe-stale copy is the whole point.
const TWO_OPERAND_OPS = new Set([8, 29, 64]);        // CALL(entry,argc), FPUSH(lo,hi), DPUSH(lo,hi)
const ONE_OPERAND_OPS = new Set([1, 2, 6, 7, 13, 14, 15, 25]);   // PUSH,GETARG,JZ,JMP,RESERVE,SETLOCAL,MKTEXT,MKSUM

// Word length of an instruction's operands (not counting the opcode word itself). op 57
// (TYPEMAP, variable-length: [57, ntot, rettype, type0..type(ntot-1)]) is handled by callers
// directly, exactly as every other oplen table in this repo does - it is not a fixed length.
export function oplen(op) {
  if (TWO_OPERAND_OPS.has(op)) return 2;
  if (ONE_OPERAND_OPS.has(op)) return 1;
  return 0;
}

// Walk the raw IR word array once, function by function (each function begins at its own
// RESERVE/op-13 header: [13, framesize]). Returns one record per function, in program order:
//   { entry: Int,               the op-13 header's own word index (= the CALL-resolvable PC)
//     directOps: Set<Int>,      every opcode this function's body executes directly (not via a call)
//     calls: Set<Int> }         the resolved entry PC of every function this one CALLs directly
// Pure and synchronous: takes a plain Int32Array/array-like of IR words, no compiler instance
// needed, so it is trivial to unit test with a hand-built word array (see effects_test.mjs).
export function extractFunctions(words) {
  const functions = [];
  let cur = null;
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 13) {
      cur = { entry: pc, directOps: new Set(), calls: new Set() };
      functions.push(cur);
      pc += 2;   // [13, framesize]; the op-57 typemap that (in every program the compiler emits)
      continue;  // immediately follows is picked up by the op===57 branch on the next iteration
    }
    if (op === 57) {
      pc += 3 + words[pc + 1];   // [57, ntot, rettype, type0..type(ntot-1)]
      continue;
    }
    if (cur) {
      if (op === 8) cur.calls.add(words[pc + 1]);   // CALL: words[pc+1] is the resolved entry
      else cur.directOps.add(op);
    }
    pc += 1 + oplen(op);
  }
  return functions;
}

// Fixpoint closure over the call graph: each function's capability set starts as whatever its
// own directOps imply (via `registry`), then repeatedly absorbs its callees' sets until nothing
// changes. Terminates in at most |functions| * |registry| rounds (capability sets only grow, and
// there are finitely many capability kinds), so mutual recursion (mu/examples/mutual.lm) and
// forward references (mu/examples/forward.lm) are handled for free - no topological sort needed.
// Pure: takes the extractFunctions() output plus a registry, returns Map<entry, Set<capability>>.
export function closeEffects(functions, registry = CAPABILITY_REGISTRY) {
  const result = new Map();
  for (const fn of functions) {
    const direct = new Set();
    for (const [capability, ops] of Object.entries(registry)) {
      for (const op of fn.directOps) {
        if (ops.has(op)) { direct.add(capability); break; }
      }
    }
    result.set(fn.entry, direct);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions) {
      const own = result.get(fn.entry);
      for (const calleeEntry of fn.calls) {
        const callee = result.get(calleeEntry);
        if (!callee) continue;   // defensive only: every CALL target in a compiled program is a
        for (const capability of callee) {   // real function entry, so this should never miss
          if (!own.has(capability)) { own.add(capability); changed = true; }
        }
      }
    }
  }
  return result;
}

// Read the compiler's symbol table (see the SYM_* constants above) into entry -> {name, line,
// signature}. Mirrors seed/lumen_mcp.mjs's symbolsFromSource byte-for-byte in technique (same
// region, same field layout, same "a function can have >1 symtab record; keep the first" rule),
// reimplemented here rather than imported because lumen_mcp.mjs is an executable MCP server entry
// point (top-level side effects on import), not a library module.
function readSymbolTable(ex, source) {
  const mem = new DataView(ex.mem.buffer);
  const u8 = new Uint8Array(ex.mem.buffer);
  const byEntry = new Map();
  for (let addr = SYM_BASE; addr < SYM_END; addr += SYM_ENTRY_BYTES) {
    const nameOff = mem.getInt32(addr, true);
    const nameLen = mem.getInt32(addr + 4, true);
    const entry = mem.getInt32(addr + 8, true);
    if (nameOff < SRC_BASE || nameOff >= SRC_END || nameLen <= 0) continue;
    if (byEntry.has(entry)) continue;
    const name = Buffer.from(u8.slice(nameOff, nameOff + nameLen)).toString('utf8');
    const marker = `fn ${name}(`;
    const idx = source.indexOf(marker);
    let line = -1, signature = '';
    if (idx !== -1) {
      const before = source.slice(0, idx);
      const lineStart = before.lastIndexOf('\n') + 1;
      let lineEnd = source.indexOf('\n', idx);
      if (lineEnd === -1) lineEnd = source.length;
      line = (before.match(/\n/g) || []).length + 1;
      signature = source.slice(lineStart, lineEnd);
    }
    byEntry.set(entry, { name, line, signature });
  }
  return byEntry;
}

// The compiler-facing entry point: compile `source` with the given warm `lumen` instance
// (createCompiler() from compiler_core.mjs, created once and reused by the caller - see
// seed/lumen.mjs's `effects` command and tools/effects_gate.mjs), derive every function's
// capability row, and return them alongside a summary. `registry` defaults to
// CAPABILITY_REGISTRY but is threaded through explicitly so a test can fixture a synthetic one.
//
// Returns on success:
//   { ok: true, registry: string[], functions: [{name,entry,line,signature,effects:string[]}],
//     summary: {total,pure,impure,purityFraction} }
// functions are sorted by entry (source/compile order), matching symbolsFromSource's convention.
// Returns on a compile error: { ok: false, functions: [], rawDiags: [...] } (rawDiags is the same
// shape compiler_core.mjs's own compile() returns; the CLI/gate layer turns it into Diagnostics).
export function effectsFromSource(lumen, source, registry = CAPABILITY_REGISTRY) {
  const c = lumen.compile(source);
  if (!c.ok) return { ok: false, functions: [], rawDiags: c.rawDiags };

  const ex = lumen.exports;
  const words = new Int32Array(ex.mem.buffer, CODE_BASE, c.irWords);
  const fns = extractFunctions(words);
  const closed = closeEffects(fns, registry);
  const names = readSymbolTable(ex, source);

  const functions = fns.map((fn) => {
    const meta = names.get(fn.entry) || { name: `fn@${fn.entry}`, line: -1, signature: '' };
    const effects = [...(closed.get(fn.entry) || [])].sort();
    return { name: meta.name, entry: fn.entry, line: meta.line, signature: meta.signature, effects };
  }).sort((a, b) => a.entry - b.entry);

  const total = functions.length;
  const pure = functions.filter((f) => f.effects.length === 0).length;
  return {
    ok: true,
    registry: Object.keys(registry),
    functions,
    summary: { total, pure, impure: total - pure, purityFraction: total === 0 ? 1 : pure / total },
  };
}
