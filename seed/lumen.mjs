#!/usr/bin/env node
// The Lumen CLI (stage-0). One warm compiler; a token-cheap structured-diagnostic surface.
//
//   lumen run    <file.lm>            compile and run, print program output
//   lumen check  <file.lm>            compile only; human diagnostics, exit 0/1
//   lumen check  <file.lm> --json     compile only; emit the structured Diagnostic stream as JSON
//   lumen fix    <file.lm>            apply confident fixes, print the repaired source (--write to save)
//   lumen ir     <file.lm>            print the compiled IR (one instruction per line)
//   lumen effects <file.lm>           per-function derived capability rows (C0; see effects.mjs)
//   lumen effects <file.lm> --json    same, as structured JSON (registry, functions, summary)
//   lumen explain <E0003>            explain a diagnostic code
//   lumen serve  [socket]            run the warm compiler daemon (lumend) over a Unix socket
//   lumen mcp                        run the MCP server (stdio) for an LLM client
//
// Runs on the native compiler + in-process JS interpreter (native/lumenc.bootstrap.c,
// native/ir_interpreter.mjs). WebAssembly/wabt retired in R5; no `npm install` is needed here.
import fs from 'node:fs';
import { explain, SCHEMA_VERSION } from './diagnostics.mjs';
import { withCache, withCacheAsync } from './cache.mjs';
import { checkAuto } from './native_check.mjs';

function usage() {
  console.error('usage: lumen <run|check|fix|ir|effects|explain|serve|mcp> [file.lm|CODE|socket] [--json] [--write]');
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positionals = argv.slice(1).filter(a => !a.startsWith('--'));
const arg = positionals[0];
if (!cmd) usage();

// `explain` needs no file and no compiler
if (cmd === 'explain') {
  const reg = explain(arg);
  if (!reg) { console.error(`lumen: unknown code ${arg}`); process.exit(1); }
  console.log(`${reg.id}  ${reg.msg}\n\n${reg.explain}`);
  process.exit(0);
}

// `serve` / `mcp` delegate to the long-lived servers (clean argv via a child process)
if (cmd === 'serve' || cmd === 'mcp') {
  const { spawn } = await import('node:child_process');
  const mod = new URL(cmd === 'serve' ? './lumend.mjs' : './lumen_mcp.mjs', import.meta.url);
  const child = spawn(process.execPath, [mod.pathname, ...positionals], { stdio: 'inherit' });
  child.on('exit', c => process.exit(c ?? 0));
} else {
  if (!['run', 'check', 'fix', 'ir', 'effects'].includes(cmd) || !arg) usage();

  let source;
  try { source = fs.readFileSync(arg, 'utf8'); }
  catch (e) { console.error(`lumen: cannot read ${arg}: ${e.message}`); process.exit(1); }

  const { createCompiler } = await import('./compiler_core.mjs');
  const { buildDiagnostics, applyFixes, fixableCount, renderHuman } = await import('./diagnostics.mjs');
  const lumen = await createCompiler();

  if (cmd === 'check') {
    // R3: check is native-first with an automatic wat fallback (checkAuto), same as
    // seed/lumend.mjs/seed/lumen_mcp.mjs. fix/ir/run stay on the wasm path below (ir's
    // disassembly reads the compiled program straight out of the wasm instance's own memory;
    // run needs the interpreter; fix iterates several wasm compiles per call already).
    const c = await withCacheAsync('check', source, () => checkAuto(lumen, source));
    const diags = buildDiagnostics(c.rawDiags, source);
    if (flags.has('--json')) {
      process.stdout.write(JSON.stringify({ schema: SCHEMA_VERSION, ok: diags.length === 0, irWords: c.irWords, fixable: fixableCount(diags), diagnostics: diags }) + '\n');
      process.exit(diags.length === 0 ? 0 : 1);
    }
    if (diags.length === 0) { console.log(`ok: compiled ${arg} (${c.irWords} IR words, main at ${c.main})`); process.exit(0); }
    for (const d of diags) console.error(renderHuman(arg, d));
    console.error(`lumen: ${diags.length} error(s), ${fixableCount(diags)} auto-fixable; not run.`);
    process.exit(1);
  }

  if (cmd === 'fix') {
    let cur = source, totalApplied = 0, rounds = 0;
    while (rounds++ < 20) {
      const c = lumen.compile(cur);
      const diags = buildDiagnostics(c.rawDiags, cur);
      if (diags.length === 0) break;
      const { source: next, applied } = applyFixes(cur, diags);
      if (applied === 0 || next === cur) break;     // converged or nothing confidently fixable
      cur = next; totalApplied += applied;
    }
    const final = lumen.compile(cur);
    const remaining = buildDiagnostics(final.rawDiags, cur);
    if (flags.has('--write')) {
      fs.writeFileSync(arg, cur);
      console.error(`lumen: applied ${totalApplied} fix(es) to ${arg}; ${remaining.length} diagnostic(s) remain.`);
    } else {
      process.stdout.write(cur);
      console.error(`lumen: applied ${totalApplied} fix(es); ${remaining.length} diagnostic(s) remain.`);
    }
    process.exit(remaining.length === 0 ? 0 : 1);
  }

  if (cmd === 'ir') {
    const r = withCache('ir', source, () => lumen.ir(source));
    if (!r.ok) { for (const d of buildDiagnostics(r.rawDiags, source)) console.error(renderHuman(arg, d)); process.exit(1); }
    console.log(r.text);
    process.exit(0);
  }

  if (cmd === 'effects') {
    // C0: per-function derived capability rows (seed/effects.mjs). Cached like `ir` (same
    // compiler-facing cost profile: one compile, then a pure in-memory walk).
    const { effectsFromSource } = await import('./effects.mjs');
    const r = withCache('effects', source, () => effectsFromSource(lumen, source));
    if (!r.ok) {
      const diags = buildDiagnostics(r.rawDiags, source);
      if (flags.has('--json')) {
        process.stdout.write(JSON.stringify({ schema: SCHEMA_VERSION, ok: false, diagnostics: diags }) + '\n');
        process.exit(1);
      }
      for (const d of diags) console.error(renderHuman(arg, d));
      console.error(`lumen: ${diags.length} error(s); not analyzed.`);
      process.exit(1);
    }
    if (flags.has('--json')) {
      process.stdout.write(JSON.stringify({ schema: SCHEMA_VERSION, ok: true, registry: r.registry, functions: r.functions, summary: r.summary }) + '\n');
      process.exit(0);
    }
    for (const f of r.functions) {
      console.log(`${f.name.padEnd(28)} ${f.effects.length === 0 ? 'pure' : f.effects.join(',')}`);
    }
    const pct = r.summary.total === 0 ? 100 : Math.round(r.summary.purityFraction * 100);
    console.log(`\n${r.summary.pure}/${r.summary.total} functions pure (${pct}%)`);
    process.exit(0);
  }

  // cmd === 'run'
  const r = withCache('run', source, () => lumen.run(source));
  if (!r.ok) {
    for (const d of buildDiagnostics(r.rawDiags, source)) console.error(renderHuman(arg, d));
    console.error(`lumen: ${r.rawDiags.length} error(s); not run.`);
    process.exit(1);
  }
  process.stdout.write(r.stdout);
}
