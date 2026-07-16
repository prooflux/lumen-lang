#!/usr/bin/env node
// Selftest for the promptgreen rig itself (not a real prompt-to-green measurement). v2: the
// rig is manifest-driven (shards.json) rather than a bare directory scan, so this selftest
// now also gates the manifest itself, in addition to everything v1 gated:
//   1. the measured rounds-to-green vector for the dev+held_out shard (10 tasks, unchanged in
//      substance) EXACTLY equals the scripted expectation
//   2. every task's hidden tests go green under the scripted author
//   3. manifest hygiene: every shards.json task dir exists, every tasks/ dir is claimed by
//      exactly one shard, no duplicates
//   4. the held_out and metamorphic seals still verify against shards.json (a continuous
//      tamper alarm: one changed byte in any sealed task's spec/reference/hidden-tests turns
//      this red)
//   5. every reference.lm across ALL 38 tasks (dev+held_out+metamorphic+extended) compiles
//      clean and passes its own hidden tests, independent of the scripted-author path above
//   6. the JSONL log is well-formed (one line per attempt, required keys, correct types;
//      tolerant of extra future keys)
// Exit 0 on success, 1 on any assertion failure (with a diagnostic printed to stderr).

import fs from 'node:fs';
import path from 'node:path';
import { createCompiler } from '../../seed/compiler_core.mjs';
import { listTaskIds, loadTask, runTask, jsonlText, TASKS_DIR } from './runner.mjs';
import { makeScriptedAuthor, EXPECTED_ROUNDS } from './scripted_author.mjs';
import { loadShards, verifyShardSeal } from './seal_check.mjs';

const REQUIRED_KEYS = ['task', 'round', 'chars_in', 'chars_out', 'diag_codes', 'green_compile', 'green_solved'];

function assert(cond, msg) {
  if (!cond) throw new Error('SELFTEST FAILED: ' + msg);
}

// --- manifest hygiene: shards.json and tasks/ must agree with each other exactly -----------
function checkManifestHygiene(shards) {
  const failures = [];
  const seenIn = new Map(); // taskId -> first shard name it was found in

  for (const [shardName, shard] of Object.entries(shards.shards)) {
    for (const id of shard.tasks) {
      if (seenIn.has(id)) {
        failures.push(`manifest hygiene: task '${id}' appears in both shard '${seenIn.get(id)}' and '${shardName}' (duplicate)`);
      } else {
        seenIn.set(id, shardName);
      }
      const dir = path.join(TASKS_DIR, id);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        failures.push(`manifest hygiene: shard '${shardName}' lists task '${id}' but ${dir} does not exist`);
      }
    }
  }

  const actualDirs = fs.readdirSync(TASKS_DIR).filter(n => {
    const full = path.join(TASKS_DIR, n);
    return /^[tm]\d+$/.test(n) && fs.statSync(full).isDirectory();
  });
  for (const dir of actualDirs) {
    if (!seenIn.has(dir)) {
      failures.push(`manifest hygiene: tasks/${dir} exists on disk but is not listed in any shard of shards.json`);
    }
  }

  return failures;
}

function allManifestTaskIds(shards) {
  const ids = [];
  for (const shard of Object.values(shards.shards)) ids.push(...shard.tasks);
  return ids.sort();
}

async function main() {
  const compiler = await createCompiler();
  let failures = 0;

  // --- (3) manifest hygiene, run first: everything below assumes the manifest is trustworthy
  const shards = loadShards();
  for (const msg of checkManifestHygiene(shards)) {
    console.error(msg);
    failures++;
  }

  // --- (4) seal verification: held_out and metamorphic must still match shards.json ----------
  for (const shardName of ['held_out', 'metamorphic']) {
    const result = verifyShardSeal(shardName, shards);
    if (!result.ok) {
      console.error(`[${shardName}] seal error: expected ${result.expected}, actual ${result.actual}` +
        (result.reason ? ` (${result.reason})` : ''));
      failures++;
    } else {
      console.log(`[${shardName}] seal OK sha256=${result.actual}`);
    }
  }

  // --- (1)+(2) scripted-author loop over exactly dev+held_out, the classic 10-task set -------
  const taskIds = listTaskIds(['dev', 'held_out']);
  assert(taskIds.length === 10, `expected 10 tasks in dev+held_out, found ${taskIds.length}: ${taskIds.join(',')}`);
  assert(
    JSON.stringify(taskIds) === JSON.stringify(Object.keys(EXPECTED_ROUNDS).sort()),
    `task set mismatch: dev+held_out=${JSON.stringify(taskIds)} expected_rounds=${JSON.stringify(Object.keys(EXPECTED_ROUNDS).sort())}`
  );

  const allJsonl = [];
  const measuredRounds = {};

  for (const id of taskIds) {
    const task = loadTask(id);
    const author = makeScriptedAuthor(id);
    const result = await runTask(task, author, { compiler });

    measuredRounds[id] = result.rounds;
    allJsonl.push(...result.jsonl);

    const wantRounds = EXPECTED_ROUNDS[id];
    if (result.rounds !== wantRounds) {
      console.error(`[${id}] rounds-to-green mismatch: got ${result.rounds}, expected ${wantRounds}`);
      failures++;
    }
    if (!result.green) {
      console.error(`[${id}] never went green within the round cap`);
      failures++;
    }
    if (!result.hiddenGreen) {
      console.error(`[${id}] hidden tests failed: ${JSON.stringify(result.hiddenDetail)}`);
      failures++;
    }
    // every round before the last must show at least one diagnostic (the whole point of the
    // scripted broken attempts is to exercise the feedback loop, not skip it)
    for (const line of result.jsonl) {
      if (!line.green_compile && line.diag_codes.length === 0) {
        console.error(`[${id}] round ${line.round} was non-green with zero diagnostics (broken-attempt design flaw)`);
        failures++;
      }
      // green_solved can only be true on a line that also compiled green (solved implies compiled)
      if (line.green_solved && !line.green_compile) {
        console.error(`[${id}] round ${line.round} has green_solved=true but green_compile=false (impossible)`);
        failures++;
      }
    }
    // the round that went green must show green_solved matching the task's hidden-test outcome
    if (result.green) {
      const greenLine = result.jsonl.find(l => l.round === result.rounds);
      if (!greenLine || greenLine.green_solved !== result.hiddenGreen) {
        console.error(`[${id}] green_solved on the green round (${greenLine && greenLine.green_solved}) does not match hiddenGreen (${result.hiddenGreen})`);
        failures++;
      }
    }
  }

  // --- (5) reference verification, extended to ALL 38 manifest tasks (dev+held_out+ ---------
  //         metamorphic+extended), independent of the scripted-author path above. t11-t30's
  //         py/ twins are Python-side data; this JS-side check never looks at them.
  const allTaskIds = allManifestTaskIds(shards);
  assert(allTaskIds.length === 38, `expected 38 manifest tasks total, found ${allTaskIds.length}`);
  for (const id of allTaskIds) {
    const task = loadTask(id);
    const compiled = compiler.run(task.reference);
    if (!compiled.ok) {
      console.error(`[${id}] reference.lm does not compile clean: ${JSON.stringify(compiled.rawDiags)}`);
      failures++;
      continue;
    }
    const hidden = await import(new URL('./tasks/' + id + '/hidden_tests.mjs', import.meta.url));
    const hres = await hidden.run((src) => compiler.run(src), task.reference);
    if (!hres.green) {
      console.error(`[${id}] reference.lm fails its own hidden tests: ${JSON.stringify(hres.detail)}`);
      failures++;
    }
  }

  // --- (6) JSONL well-formedness (dev+held_out attempts only; tolerant of extra future keys) -
  const jsonlBody = jsonlText(allJsonl);
  const lines = jsonlBody.split('\n').filter(l => l.length > 0);
  assert(lines.length === allJsonl.length, `jsonlText produced ${lines.length} lines, expected ${allJsonl.length}`);
  for (const [i, line] of lines.entries()) {
    let obj;
    try { obj = JSON.parse(line); }
    catch (e) { console.error(`jsonl line ${i} is not valid JSON: ${line}`); failures++; continue; }
    for (const k of REQUIRED_KEYS) {
      if (!(k in obj)) { console.error(`jsonl line ${i} missing key '${k}': ${line}`); failures++; }
    }
    if (typeof obj.round !== 'number' || obj.round < 1) { console.error(`jsonl line ${i} bad round: ${line}`); failures++; }
    if (typeof obj.chars_in !== 'number' || typeof obj.chars_out !== 'number') { console.error(`jsonl line ${i} bad char counts: ${line}`); failures++; }
    if (!Array.isArray(obj.diag_codes)) { console.error(`jsonl line ${i} diag_codes not an array: ${line}`); failures++; }
    if (typeof obj.green_compile !== 'boolean') { console.error(`jsonl line ${i} green_compile not boolean: ${line}`); failures++; }
    if (typeof obj.green_solved !== 'boolean') { console.error(`jsonl line ${i} green_solved not boolean: ${line}`); failures++; }
    // extra keys beyond REQUIRED_KEYS are fine (forward-compatible schema growth); no check
    // rejects them here, by design.
  }

  console.log('measured rounds-to-green (dev+held_out):', JSON.stringify(measuredRounds));
  console.log('expected rounds-to-green:', JSON.stringify(EXPECTED_ROUNDS));
  console.log('jsonl lines:', lines.length);
  console.log('reference.lm verified across all manifest tasks:', allTaskIds.length);

  if (failures > 0) {
    console.error(`\nSELFTEST FAILED: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nSELFTEST OK: manifest hygiene clean, held_out+metamorphic seals verified, ' +
    '10/10 dev+held_out tasks measured correctly, all hidden tests green, ' +
    `${allTaskIds.length}/${allTaskIds.length} reference.lm verified, jsonl well-formed`);
  process.exit(0);
}

main().catch(e => {
  console.error(e && e.stack || e);
  process.exit(1);
});
