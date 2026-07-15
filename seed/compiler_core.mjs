// Lumen stage-0 warm-compiler core. Assembles lumenc.wat ONCE and exposes a reusable
// compile/run/ir surface, so a long-lived process (the CLI, the `lumen serve` daemon,
// the MCP server) keeps the WASM compiler hot. Compile is sub-millisecond; the only
// one-time cost is the WAT assemble. The globals reset inside lex_compile, so one
// instance compiles many sources sequentially. Zero-legacy note: this host shim and the
// `wabt` assembler are bootstrap scaffolds, re-derived in Lumen at the self-hosting fixpoint.
import fs from 'node:fs';
import wabtInit from 'wabt';

export const SRC_BASE = 100000;
export const SRC_CAPACITY = 50000;   // SRC region is [100000,150000); a longer source overruns into the TOKENS region at 150000
export const DIAG_BASE = 286000;   // compile-error records: (code, name_off, name_len) x i32
export const CODE_BASE = 11328;   // emitted IR words

export const OPS = {0:'HALT',1:'PUSH',2:'GETARG',3:'ADD',4:'SUB',5:'LT',6:'JZ',7:'JMP',8:'CALL',
  9:'RET',10:'PRINTINT',11:'MUL',12:'DIV',13:'RESERVE',14:'SETLOCAL',15:'MKTEXT',
  16:'PRINTTEXT',17:'CONCAT',18:'INT2TEXT',19:'EQ',20:'NE',21:'LE',22:'GE',23:'GT',24:'MOD',
  25:'MKSUM',26:'SUMTAG',27:'SUMVAL',28:'TEXTEQ',
  29:'FPUSH',   // float literal (two 32-bit halves, like DPUSH) - was missing a name entirely
  53:'LOAD32',54:'STORE32',55:'LOAD8',56:'STORE8',   // raw-memory keystone (self-host + native emitter/optimizer)
  58:'BAND',59:'BOR',60:'BXOR',61:'SHL',62:'SHR',63:'BNOT',   // bitwise builtins (stack ops, no inline operands)
  64:'DPUSH',65:'DFROMI',66:'DADD',67:'DSUB',68:'DMUL',69:'DDIV',70:'D2TEXT'};   // Dec: exact decimal, i64 scale 1e-6 (D1)

// Canonical fixed-width operand-word count for any opcode EXCEPT TYPEMAP(57), which is
// variable-length ([57, ntot, rettype, type0..type(ntot-1)]: 3+ntot words) and is handled
// separately by every caller, exactly as ir() does below. Single source of truth: exported so
// seed/lumen_mcp.mjs's typesFromSource imports this instead of keeping its own copy - four
// independent instances of this exact table (native/pipeline.mjs, native/optimize.lm, native/
// emit_llvm.lm each missing DPUSH's width at some point during D2/D3; this pair - ir() and
// typesFromSource - missing it going into this fix) is the argument for unifying the two files
// that already share an import line, not for a fifth still-independent copy.
export function oplen(op) {
  if (op === 8 || op === 29 || op === 64) return 2;   // CALL(entry,argc), FPUSH(lo,hi), DPUSH(lo,hi)
  if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) return 1;
  return 0;
}

// Create a warm compiler. `await createCompiler()` once, reuse forever.
export async function createCompiler() {
  const wabt = await wabtInit();
  const wat = fs.readFileSync(new URL('./lumenc.wat', import.meta.url), 'utf8');
  const assembleStart = process.hrtime.bigint();
  const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  const assembleMs = Number(process.hrtime.bigint() - assembleStart) / 1e6;
  const ex = instance.exports;

  function loadSource(source) {
    const bytes = Buffer.from(source, 'utf8');
    if (bytes.length > SRC_CAPACITY)   // guard: a too-long source would overrun SRC and corrupt the keyword table (silent, in a warm daemon)
      throw new Error(`source ${bytes.length}B exceeds SRC capacity ${SRC_CAPACITY}B (raise the memory map before self-hosting lumenc.lm)`);
    new Uint8Array(ex.mem.buffer, SRC_BASE, bytes.length).set(bytes);
    return bytes.length;
  }

  // raw diagnostics straight off the compiler's record region; the schema layer adds codes/spans/fixes.
  function readRawDiags() {
    const n = ex.dbg_nerr();
    const recs = new Int32Array(ex.mem.buffer, DIAG_BASE, n * 3);
    const m = new Uint8Array(ex.mem.buffer);
    const ds = [];
    for (let k = 0; k < n; k++) {
      const code = recs[k*3], off = recs[k*3+1], len = recs[k*3+2];
      const name = (off >= SRC_BASE && len > 0) ? Buffer.from(m.slice(off, off+len)).toString('utf8') : '';
      ds.push({ code, byteOff: off - SRC_BASE, byteLen: len, name });
    }
    return ds;
  }

  // compile only; returns IR metadata + raw diagnostics (never throws on a user error)
  function compile(source) {
    const srclen = loadSource(source);
    let irWords;
    try { irWords = ex.compile(srclen); }
    catch (e) { return { ok: false, irWords: 0, main: 0, srclen, rawDiags: [], crash: String(e.message || e) }; }
    const rawDiags = readRawDiags();
    return { ok: rawDiags.length === 0, irWords, main: ex.dbg_main(), srclen, rawDiags };
  }

  // compile then run; returns stdout (empty if compile produced diagnostics)
  function run(source) {
    const c = compile(source);
    if (!c.ok) return { ...c, stdout: '' };
    out = '';
    if (ex.set_fuel_max) ex.set_fuel_max(4000000000n);
    try { ex.run(c.main); }
    catch (e) { return { ...c, stdout: out, crash: String(e.message || e) }; }
    return { ...c, stdout: out };
  }

  // IR disassembly text (one instruction per line). TYPEMAP(57) is a variable-length compile-
  // time metadata record, not an instruction the interpreter ever dispatches on at runtime (every
  // other IR consumer in this repo skips it the same way, 3+ntot words); it gets its own line
  // here rather than falling through to the generic path, which would otherwise scatter its
  // ntot/rettype/slot-type payload words across several bogus "instructions".
  function ir(source) {
    const c = compile(source);
    if (!c.ok) return { ...c, text: '' };
    const code = new Int32Array(ex.mem.buffer, CODE_BASE, c.irWords);
    const lines = [];
    let i = 0;
    while (i < c.irWords) {
      const op = code[i];
      if (op === 57) {
        const ntot = code[i + 1];
        const slots = Array.from({ length: ntot }, (_, k) => code[i + 3 + k]);
        lines.push(`${String(i).padStart(4)}  TYPEMAP  ntot=${ntot} rettype=${code[i + 2]} slots=[${slots.join(',')}]`);
        i += 3 + ntot;
        continue;
      }
      let s = String(i).padStart(4) + '  ' + (OPS[op] || `?${op}`);
      const n = oplen(op);
      if (op === 8) s += `  entry=${code[i + 1]} argc=${code[i + 2]}`;
      else if (n === 2) s += `  ${code[i + 1]} ${code[i + 2]}`;
      else if (n === 1) s += `  ${code[i + 1]}`;
      i += 1 + n;
      lines.push(s);
    }
    return { ...c, text: lines.join('\n') };
  }

  return { compile, run, ir, assembleMs, exports: ex };
}
