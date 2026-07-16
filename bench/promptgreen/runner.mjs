// promptgreen v0 runner: the prompt-to-green protocol described in
// docs/LUMEN_UNIVERSAL_COVERAGE_PLAN.md section 4, run hermetically (no network, no real
// model). An author is any async function (spec, priorDiagnostics) -> source. On each
// non-green compile the runner feeds back ONLY the structured diagnostics (never the hidden
// tests) and asks again, up to a fixed round cap. On green it runs the task's hidden tests.
//
// Token counting is a pluggable hook: tokenize(text) -> int. The default below is a
// PLACEHOLDER (chars/4) until a pinned real tokenizer lands; never report its output as
// "tokens" without the "approx" prefix (see README.md).
//
// Task discovery is manifest-driven (shards.json), not a bare directory scan: see
// shards.json's "corpus shards" section in README.md. listTaskIds() defaults to the two
// shards that make up the classic 10-task selftest set (dev + held_out); the metamorphic
// shard is reachable only by asking for it explicitly, so it never silently joins a run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCompiler } from '../../seed/compiler_core.mjs';
import { buildDiagnostics } from '../../seed/diagnostics.mjs';
import { loadShards } from './seal_check.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROUND_CAP = 5;

// Placeholder token-count hook. chars/4 is a crude English-text approximation with no
// relationship to any real model's tokenizer; callers must label anything derived from it
// "approx tokens", never "tokens".
export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

export const TASKS_DIR = path.join(__dirname, 'tasks');

// Task ids for a set of shards (see shards.json), sorted. Defaults to dev+held_out: the same
// 10 frozen tasks the classic selftest has always measured. Pass ['metamorphic'] explicitly
// to reach m03..m10, or ['extended'] for the staged v2 corpus (t11..t30, not yet part of any
// measured run).
export function listTaskIds(shardNames = ['dev', 'held_out']) {
  const shards = loadShards();
  const ids = [];
  for (const name of shardNames) {
    const shard = shards.shards[name];
    if (!shard) throw new Error(`listTaskIds: unknown shard '${name}' (see shards.json)`);
    ids.push(...shard.tasks);
  }
  return ids.sort();
}

export function loadTask(taskId) {
  const dir = path.join(TASKS_DIR, taskId);
  const specPath = path.join(dir, 'spec.md');
  const hiddenPath = path.join(dir, 'hidden_tests.mjs');
  const refPath = path.join(dir, 'reference.lm');
  return {
    id: taskId,
    dir,
    spec: fs.readFileSync(specPath, 'utf8'),
    hiddenTestsPath: hiddenPath,
    referencePath: refPath,
    reference: fs.readFileSync(refPath, 'utf8'),
  };
}

// Serialize structured diagnostics into the plain text an author would read back (the "real
// dev loop" feedback channel). Never includes hidden-test information; diagnostics only.
export function renderDiagnosticsText(diags) {
  if (diags.length === 0) return '';
  return diags.map(d => {
    const tail = d.name ? ` '${d.name}'` : '';
    return `${d.code} line ${d.line} col ${d.col}: ${d.msg}${tail}`;
  }).join('\n');
}

// Run one task against one author. Returns { taskId, rounds, green, hiddenGreen, hiddenDetail,
// attempts: [...], jsonl: [...] }. `attempts[i]` carries the round, source, diagnostics, and
// green flag; `jsonl` carries the exact log lines (objects; caller decides how to persist).
export async function runTask(task, author, opts = {}) {
  const roundCap = opts.roundCap ?? ROUND_CAP;
  const tokenize = opts.tokenize ?? approxTokens;
  const compiler = opts.compiler ?? (await createCompiler());

  const attempts = [];
  const jsonl = [];
  let priorDiagnostics = null; // text fed back to the author; null on round 1
  let green = false;
  let round = 0;
  let lastSource = '';
  let lastCompile = null;

  for (round = 1; round <= roundCap; round++) {
    const authorInputText = round === 1 ? task.spec : (task.spec + '\n\n' + priorDiagnostics);
    const source = await author(task.spec, priorDiagnostics, round);
    lastSource = source;
    const compiled = compiler.run(source);
    lastCompile = compiled;
    const diags = buildDiagnostics(compiled.rawDiags || [], source);
    const diagCodes = diags.map(d => d.code);
    green = compiled.ok === true;

    // green_solved is filled in below, once we know the hidden-test outcome (only ever true on
    // the round that also compiled green: solving implies compiling). Every non-green round is
    // green_solved:false by construction (see PREREGISTRATION_v1.md Definitions: Solved =
    // green AND hidden_tests.mjs reports green:true).
    const line = {
      task: task.id,
      round,
      chars_in: authorInputText.length,
      chars_out: source.length,
      approx_tokens_in: tokenize(authorInputText),
      approx_tokens_out: tokenize(source),
      diag_codes: diagCodes,
      green_compile: green,
      green_solved: false,
    };
    jsonl.push(line);
    attempts.push({ round, source, diags, green, stdout: compiled.stdout });

    if (green) break;
    priorDiagnostics = renderDiagnosticsText(diags);
  }

  let hiddenGreen = false;
  let hiddenDetail = null;
  if (green) {
    const hidden = await import(pathToFileURL(task.hiddenTestsPath).href);
    const result = await hidden.run((src) => compiler.run(src), lastSource);
    hiddenGreen = !!result.green;
    hiddenDetail = result.detail ?? null;
    // patch the green round's JSONL line now that the hidden-test outcome is known
    jsonl[jsonl.length - 1].green_solved = hiddenGreen;
  }

  return {
    taskId: task.id,
    rounds: green ? round : null, // null means never went green within the cap
    green,
    hiddenGreen,
    hiddenDetail,
    attempts,
    jsonl,
  };
}

// Run every task under tasks/ against one author. Returns { results: [...], jsonl: [flat] }.
export async function runAll(author, opts = {}) {
  const compiler = opts.compiler ?? (await createCompiler());
  const results = [];
  const jsonl = [];
  for (const id of listTaskIds()) {
    const task = loadTask(id);
    const r = await runTask(task, author, { ...opts, compiler });
    results.push(r);
    jsonl.push(...r.jsonl);
  }
  return { results, jsonl };
}

export function jsonlText(lines) {
  return lines.map(l => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}
