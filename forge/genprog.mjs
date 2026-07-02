#!/usr/bin/env node
// Deterministic, type-directed random Lumen-mu program generator.
// `node genprog.mjs <seed>` prints one complete program to stdout.
// Same seed = byte-identical output. All randomness flows through a
// seeded xorshift64star PRNG (no Math.random, no Date).

// ---------- xorshift64star PRNG ----------
class RNG {
  constructor(seed) {
    // splitmix64-ish seed spread so small integer seeds don't collide badly
    let s = BigInt.asUintN(64, BigInt(seed) ^ 0x9e3779b97f4a7c15n);
    if (s === 0n) s = 0x2545f4914f6cdd1dn;
    this.state = s;
  }
  nextU64() {
    let x = this.state;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffffffffffffffffn;
    x ^= x >> 27n;
    this.state = x & 0xffffffffffffffffn;
    return BigInt.asUintN(64, this.state * 0x2545f4914f6cdd1dn);
  }
  // integer in [lo, hi] inclusive
  int(lo, hi) {
    const range = BigInt(hi - lo + 1);
    const v = this.nextU64() % range;
    return lo + Number(v);
  }
  // float in [0, 1)
  float01() {
    const v = this.nextU64() & 0xffffffffffffn; // 48 bits
    return Number(v) / Number(0x1000000000000n);
  }
  // true with probability p
  chance(p) {
    return this.float01() < p;
  }
  pick(arr) {
    return arr[this.int(0, arr.length - 1)];
  }
}

// ---------- helpers ----------
const TYPES = ['Int', 'Float', 'Text'];

function fmtInt(n) {
  return String(n);
}

// one-decimal float literal in [-50.0, 50.0]
function randFloatLit(rng) {
  const whole = rng.int(-50, 50);
  const dec = rng.int(0, 9);
  // avoid "-0.0" oddities; keep as-is, it's a legal literal either way
  return `${whole}.${dec}`;
}

function randTextLit(rng) {
  const words = ['abc', 'hi there', 'Lumen 42', 'fx', 'quant', 'report', 'ok', 'run 7', 'row', 'val'];
  let s = rng.pick(words);
  if (rng.chance(0.3)) s += '\\n';
  return `"${s}"`;
}

// ---------- name allocation ----------
class NameGen {
  constructor() {
    this.n = 0;
  }
  fresh() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const i = this.n++;
    const letter = letters[i % 26];
    const suffix = Math.floor(i / 26);
    return suffix === 0 ? letter : `${letter}${suffix}`;
  }
}

// ---------- scope ----------
// A Scope is a list of frames; each frame is Map<name, {type, mutable}>.
class Scope {
  constructor() {
    this.frames = [new Map()];
  }
  push() {
    this.frames.push(new Map());
  }
  pop() {
    this.frames.pop();
  }
  declare(name, type, mutable) {
    this.frames[this.frames.length - 1].set(name, { type, mutable });
  }
  lookup(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].has(name)) return this.frames[i].get(name);
    }
    return undefined;
  }
  // all names visible right now, optionally filtered by type / mutability
  visible(filterType, mutableOnly) {
    const seen = new Map();
    for (const frame of this.frames) {
      for (const [name, info] of frame) {
        if (filterType && info.type !== filterType) continue;
        if (mutableOnly && !info.mutable) continue;
        seen.set(name, info); // later (inner) frames overwrite outer with same name
      }
    }
    return [...seen.keys()];
  }
}

// ---------- expression generation ----------
// ctx: { rng, scope, fns /* array of {name,params:[type..],ret,hasConsole} defined-above */,
//        consoleVar /* name or null */, names /* NameGen for locals, unused here */ }

function callableReturning(ctx, retType) {
  return ctx.fns.filter((f) => f.ret === retType && (!f.hasConsole || ctx.consoleVar));
}

function genCall(ctx, fn, argDepth) {
  const args = fn.params.map((pt) => genExprOfType(ctx, pt, argDepth));
  if (fn.hasConsole) args.push(ctx.consoleVar);
  return `${fn.name}(${args.join(', ')})`;
}

function genExprOfType(ctx, type, depth) {
  if (type === 'Int') return genInt(ctx, depth);
  if (type === 'Float') return genFloat(ctx, depth);
  if (type === 'Text') return genText(ctx, depth);
  throw new Error(`no expr generator for type ${type}`);
}

function genInt(ctx, depth) {
  const { rng, scope } = ctx;
  const refs = scope.visible('Int');
  const calls = callableReturning(ctx, 'Int');

  // leaf choices, always available. 'call' only when depth > 0 so recursion strictly
  // terminates (args are generated at depth-1, never re-using the current depth).
  const leafChoices = ['lit'];
  if (refs.length) leafChoices.push('ref');
  if (depth > 0 && calls.length) leafChoices.push('call');

  if (depth <= 0 || rng.chance(0.35)) {
    const choice = rng.pick(leafChoices);
    if (choice === 'lit') return fmtInt(rng.int(-100, 100));
    if (choice === 'ref') return rng.pick(refs);
    if (choice === 'call') return genCall(ctx, rng.pick(calls), depth - 1);
  }

  const ops = ['+', '-', '*', '/', '%', 'cmp', 'logic', 'unary', 'to_int', 'round'];
  const choice = rng.pick(ops);
  if (choice === '+' || choice === '-' || choice === '*' || choice === '/' || choice === '%') {
    const l = genInt(ctx, depth - 1);
    const r = genInt(ctx, depth - 1);
    return `(${l} ${choice} ${r})`;
  }
  if (choice === 'cmp') {
    const cmpOp = rng.pick(['<', '<=', '>', '>=', '==', '!=']);
    const l = genInt(ctx, depth - 1);
    const r = genInt(ctx, depth - 1);
    return `(${l} ${cmpOp} ${r})`;
  }
  if (choice === 'logic') {
    const logicOp = rng.pick(['and', 'or']);
    // operands are comparison-shaped Int expressions (0/1-valued)
    const l = genComparisonInt(ctx, depth - 1);
    const r = genComparisonInt(ctx, depth - 1);
    return `(${l} ${logicOp} ${r})`;
  }
  if (choice === 'unary') {
    const inner = genInt(ctx, depth - 1);
    return `-(${inner})`;
  }
  if (choice === 'to_int') {
    const f = genFloat(ctx, depth - 1);
    return `to_int(${f})`;
  }
  if (choice === 'round') {
    const f = genFloat(ctx, depth - 1);
    return `round(${f})`;
  }
  // fallback
  return fmtInt(rng.int(-100, 100));
}

// generate an Int expression that is comparison-shaped (safe operand for and/or/not)
function genComparisonInt(ctx, depth) {
  const { rng } = ctx;
  if (rng.chance(0.5)) {
    const cmpOp = rng.pick(['<', '<=', '>', '>=', '==', '!=']);
    const l = genInt(ctx, Math.max(0, depth - 1));
    const r = genInt(ctx, Math.max(0, depth - 1));
    return `(${l} ${cmpOp} ${r})`;
  }
  return genInt(ctx, depth);
}

function genFloat(ctx, depth) {
  const { rng, scope } = ctx;
  const refs = scope.visible('Float');
  const calls = callableReturning(ctx, 'Float');

  const leafChoices = ['lit'];
  if (refs.length) leafChoices.push('ref');
  if (depth > 0 && calls.length) leafChoices.push('call');

  if (depth <= 0 || rng.chance(0.35)) {
    const choice = rng.pick(leafChoices);
    if (choice === 'lit') return randFloatLit(rng);
    if (choice === 'ref') return rng.pick(refs);
    if (choice === 'call') return genCall(ctx, rng.pick(calls), depth - 1);
  }

  const ops = ['+', '-', '*', '/', 'to_float', 'sqrt', 'abs', 'exp', 'ln', 'pow'];
  const choice = rng.pick(ops);
  if (choice === '+' || choice === '-' || choice === '*' || choice === '/') {
    const l = genFloat(ctx, depth - 1);
    const r = genFloat(ctx, depth - 1);
    return `(${l} ${choice} ${r})`;
  }
  if (choice === 'to_float') {
    const i = genInt(ctx, depth - 1);
    return `to_float(${i})`;
  }
  if (choice === 'sqrt') {
    const f = genFloat(ctx, depth - 1);
    return `sqrt(abs(${f}))`;
  }
  if (choice === 'abs') {
    const f = genFloat(ctx, depth - 1);
    return `abs(${f})`;
  }
  if (choice === 'exp') {
    // domain guard: keep the operand small via a literal-bounded ref we construct
    const lit = randFloatLit(rng);
    return `exp(${lit})`;
  }
  if (choice === 'ln') {
    const f = genFloat(ctx, depth - 1);
    return `ln((abs(${f}) + 1.0))`;
  }
  if (choice === 'pow') {
    const f = genFloat(ctx, depth - 1);
    const expLit = `${rng.int(0, 3)}.0`;
    return `pow(abs(${f}), ${expLit})`;
  }
  return randFloatLit(rng);
}

function genText(ctx, depth) {
  const { rng, scope } = ctx;
  const refs = scope.visible('Text');
  const calls = callableReturning(ctx, 'Text');

  const leafChoices = ['lit'];
  if (refs.length) leafChoices.push('ref');
  if (depth > 0 && calls.length) leafChoices.push('call');

  if (depth <= 0 || rng.chance(0.4)) {
    const choice = rng.pick(leafChoices);
    if (choice === 'lit') return randTextLit(rng);
    if (choice === 'ref') return rng.pick(refs);
    if (choice === 'call') return genCall(ctx, rng.pick(calls), depth - 1);
  }

  const ops = ['int_to_text', 'concat'];
  const choice = rng.pick(ops);
  if (choice === 'int_to_text') {
    const i = genInt(ctx, depth - 1);
    return `int_to_text(${i})`;
  }
  const a = genText(ctx, depth - 1);
  const b = genText(ctx, depth - 1);
  return `text_concat(${a}, ${b})`;
}

// ---------- statement generation ----------
// budget: {stmts: number remaining}, returns array of source lines (already indented body-relative)
function genBlock(ctx, budget, depth, indent, names, allowFinalReturn) {
  const lines = [];
  const target = Math.max(1, Math.min(budget.stmts, ctx.rng.int(1, 3)));
  let emitted = 0;
  while (emitted < target && budget.stmts > 0) {
    const line = genStatement(ctx, budget, depth, indent, names);
    if (line) {
      lines.push(line);
      emitted++;
    }
  }
  return lines;
}

function ind(n) {
  return '  '.repeat(n);
}

function genStatement(ctx, budget, depth, indent, names) {
  const { rng, scope } = ctx;
  budget.stmts--;

  const canNest = depth < 2;
  const choices = ['let', 'let', 'var', 'assign', 'if', 'exprstmt'];
  if (canNest) choices.push('if', 'while');
  const mutables = scope.visible(undefined, true);
  if (mutables.length === 0) {
    // remove 'assign' if nothing mutable
    const i = choices.indexOf('assign');
    if (i >= 0) choices.splice(i, 1);
  }

  const choice = rng.pick(choices);

  if (choice === 'let' || choice === 'var') {
    const type = rng.pick(TYPES);
    const existingSameType = scope.visible(type);
    // deliberate shadowing: reuse an existing name sometimes, else fresh
    let name;
    if (existingSameType.length && rng.chance(0.2)) {
      name = rng.pick(existingSameType);
    } else {
      name = names.fresh();
    }
    const expr = genExprOfType(ctx, type, 3);
    scope.declare(name, type, choice === 'var');
    return `${ind(indent)}${choice} ${name} = ${expr}`;
  }

  if (choice === 'assign') {
    const name = rng.pick(mutables);
    const type = scope.lookup(name).type;
    const expr = genExprOfType(ctx, type, 3);
    return `${ind(indent)}${name} = ${expr}`;
  }

  if (choice === 'exprstmt') {
    // bare call-as-statement, exercising the discard slot
    const anyRet = ['Int', 'Float', 'Text'].flatMap((t) => callableReturning(ctx, t).map((f) => ({ f, t })));
    if (anyRet.length === 0) {
      budget.stmts++; // refund, fall back to a cheap let
      const expr = genExprOfType(ctx, 'Int', 1);
      const name = names.fresh();
      scope.declare(name, 'Int', false);
      budget.stmts--;
      return `${ind(indent)}let ${name} = ${expr}`;
    }
    const { f } = rng.pick(anyRet);
    return `${ind(indent)}${genCall(ctx, f, 1)}`;
  }

  if (choice === 'if') {
    const cond = genComparisonInt(ctx, 2);
    scope.push();
    const innerBudget = { stmts: Math.min(budget.stmts, rng.int(1, 3)) };
    budget.stmts -= innerBudget.stmts - innerBudget.stmts; // no-op, budget tracked via shared counter below
    const thenLines = genThenBlock(ctx, budget, depth + 1, indent + 1, names);
    scope.pop();
    let out = `${ind(indent)}if ${cond} {\n${thenLines.join('\n')}\n${ind(indent)}}`;
    if (rng.chance(0.4) && budget.stmts > 0) {
      scope.push();
      const elseLines = genThenBlock(ctx, budget, depth + 1, indent + 1, names);
      scope.pop();
      out += ` else {\n${elseLines.join('\n')}\n${ind(indent)}}`;
    }
    return out;
  }

  if (choice === 'while') {
    const counter = `i${names.n}`;
    names.n++; // reserve, keep fresh() distinct series
    const bound = rng.int(2, 8);
    scope.declare(counter, 'Int', true);
    scope.push();
    const bodyLines = genThenBlock(ctx, budget, depth + 1, indent + 1, names);
    scope.pop();
    let body = bodyLines.join('\n');
    if (body.length) body += '\n';
    return `${ind(indent)}var ${counter} = 0\n${ind(indent)}while ${counter} < ${bound} {\n${body}${ind(indent + 1)}${counter} = ${counter} + 1\n${ind(indent)}}`;
  }

  // fallback
  const expr = genExprOfType(ctx, 'Int', 1);
  const name = names.fresh();
  scope.declare(name, 'Int', false);
  return `${ind(indent)}let ${name} = ${expr}`;
}

// small non-empty block used for if/while bodies; guarantees at least one statement
function genThenBlock(ctx, budget, depth, indent, names) {
  const lines = [];
  const n = Math.max(1, Math.min(budget.stmts + 1, ctx.rng.int(1, 2)));
  let emitted = 0;
  while (emitted < n) {
    if (budget.stmts <= 0) {
      // force at least one cheap statement without consuming budget below zero repeatedly
      budget.stmts = 1;
    }
    const line = genStatement(ctx, budget, depth, indent, names);
    if (line) {
      lines.push(line);
      emitted++;
    }
  }
  return lines;
}

// ---------- function generation ----------
function genHelperFn(rng, index, prevFns) {
  const name = `fn${index}`;
  const paramCount = rng.int(0, 3);
  const paramTypes = [];
  for (let i = 0; i < paramCount; i++) paramTypes.push(rng.pick(['Int', 'Float', 'Text']));
  const hasConsole = rng.chance(0.3);
  const retType = rng.pick(['Int', 'Float', 'Text', 'Unit']);

  const scope = new Scope();
  const names = new NameGen();
  const paramNames = [];
  for (let i = 0; i < paramCount; i++) {
    const pname = names.fresh();
    paramNames.push(pname);
    scope.declare(pname, paramTypes[i], false);
  }
  let consoleVar = null;
  if (hasConsole) {
    consoleVar = 'console';
    // 'console' is not a plain data var; keep it out of the general name pool by not declaring it in scope's type map,
    // callers reference it directly via ctx.consoleVar.
  }

  const ctx = { rng, scope, fns: prevFns, consoleVar };
  const totalStmts = rng.int(2, 12);
  const budget = { stmts: retType === 'Unit' ? totalStmts : Math.max(1, totalStmts - 1) };
  const bodyLines = genBlock(ctx, budget, 0, 1, names, true);

  // final statement
  let finalLine;
  if (retType === 'Unit') {
    // Bare `return` (no expr) is not supported by the seed compiler (verified empirically);
    // Unit fns always fall through instead. `return <UnitExpr>` isn't in the grammar contract
    // either, so fall-through is the only legal terminator we emit here.
    finalLine = null;
  } else {
    const expr = genExprOfType(ctx, retType, 3);
    finalLine = `${ind(1)}return ${expr}`;
  }

  const lines = [...bodyLines];
  if (finalLine) lines.push(finalLine);
  if (lines.length === 0) lines.push(`${ind(1)}return`);

  const paramList = paramNames
    .map((n, i) => `${n}: ${paramTypes[i]}`)
    .concat(hasConsole ? ['console: Console'] : [])
    .join(', ');
  const retAnnotation = retType === 'Unit' ? 'Unit' : retType;

  const src = `fn ${name}(${paramList}) -> ${retAnnotation} {\n${lines.join('\n')}\n}`;
  return {
    src,
    meta: { name, params: paramTypes, ret: retType, hasConsole },
  };
}

function genMainFn(rng, allFns) {
  const scope = new Scope();
  const names = new NameGen();
  const ctx = { rng, scope, fns: allFns, consoleVar: 'console' };

  const totalStmts = rng.int(3, 12);
  const budget = { stmts: totalStmts };
  const lines = [];
  let emitted = 0;
  while (emitted < totalStmts && budget.stmts > 0) {
    // bias toward printing something interesting
    if (rng.chance(0.4)) {
      const kind = rng.pick(['int', 'text']);
      budget.stmts--;
      if (kind === 'int') {
        const e = genInt(ctx, 3);
        lines.push(`${ind(1)}console.print_int(${e})`);
      } else {
        const e = genText(ctx, 3);
        lines.push(`${ind(1)}console.print(${e})`);
      }
      emitted++;
    } else {
      const line = genStatement(ctx, budget, 0, 1, names);
      if (line) {
        lines.push(line);
        emitted++;
      }
    }
  }
  if (lines.length === 0) {
    lines.push(`${ind(1)}console.print_int(0)`);
  }
  return `fn main(console: Console) -> Unit {\n${lines.join('\n')}\n}`;
}

// ---------- program generation ----------
export function generateProgram(seed) {
  const rng = new RNG(seed);
  const fnCount = rng.int(1, 6);
  const fns = [];
  const srcs = [];
  for (let i = 1; i <= fnCount; i++) {
    const { src, meta } = genHelperFn(rng, i, fns.slice());
    fns.push(meta);
    srcs.push(src);
  }
  const mainSrc = genMainFn(rng, fns);
  srcs.push(mainSrc);
  return srcs.join('\n\n') + '\n';
}

// alias used by forge/forge.mjs's module import contract
export const generate = generateProgram;

// ---------- CLI ----------
function main() {
  const arg = process.argv[2];
  if (arg === undefined) {
    process.stderr.write('usage: node genprog.mjs <seed>\n');
    process.exit(1);
  }
  const seed = Number(arg);
  process.stdout.write(generateProgram(seed));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
