#!/usr/bin/env node
// scoreboard_gate_test.mjs - smoke test for tools/scoreboard_gate.mjs's schema and flip-coupling
// logic, exercised as in-memory fixtures against the exported pure functions
// (checkDimensionFields, checkIdSet, checkSchema, checkEvidenceExists, checkFlipCouplingPure).
// No real git repository is needed: flip-coupling's git-facing wrapper (checkFlipCoupling) stays
// thin and untested here, exactly like purity_gate.mjs's own git calls - everything worth
// verifying is pure and lives in the functions this file imports.
//
// Run: node tools/scoreboard_gate_test.mjs
// Exit 0 on all-pass, 1 on any failure (with each failing case printed).

import {
  checkDimensionFields,
  checkIdSet,
  checkSchema,
  checkEvidenceExists,
  checkFlipCouplingPure,
} from './scoreboard_gate.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`PASS  ${msg}`);
  } else {
    console.error(`FAIL  ${msg}`);
    failures++;
  }
}
function checkEmpty(arr, msg) {
  check(Array.isArray(arr) && arr.length === 0, `${msg} (got: ${JSON.stringify(arr)})`);
}
function checkNonEmpty(arr, msg) {
  check(Array.isArray(arr) && arr.length > 0, `${msg} (got: ${JSON.stringify(arr)})`);
}

// A minimal, valid dimension fixture. Override fields per test case.
function dim(overrides = {}) {
  return {
    id: '3',
    name: 'test-dimension',
    python_verdict: 'won-by-design',
    field_verdict: 'won-across-field',
    gate: 'the gate sentence',
    metric: 'the metric',
    value: null,
    evidence: ['bench/DASHBOARD.md'],
    wave: null,
    arc: null,
    last_flip: null,
    note: 'a note',
    ...overrides,
  };
}

console.log('=== checkDimensionFields ===');
checkEmpty(checkDimensionFields(dim()), 'a fully valid dimension has no failures');
checkNonEmpty(
  checkDimensionFields(dim({ python_verdict: 'totally-invented' })),
  'an invalid python_verdict is caught',
);
checkNonEmpty(
  checkDimensionFields(dim({ field_verdict: 'totally-invented' })),
  'an invalid field_verdict is caught',
);
checkEmpty(
  checkDimensionFields(dim({ python_verdict: null })),
  'python_verdict: null is valid (dimension 7b has no Python-side claim)',
);
checkNonEmpty(
  checkDimensionFields(dim({ name: '' })),
  'a missing name is caught',
);
checkNonEmpty(
  checkDimensionFields(dim({ last_flip: { sha: 'abc123' } })),
  'a malformed last_flip (wrong shape: no date/evidence keys) is caught',
);
checkNonEmpty(
  checkDimensionFields(dim({ last_flip: { date: 'not-a-date', evidence: 'bench/DASHBOARD.md' } })),
  'a last_flip with a non-YYYY-MM-DD date is caught',
);
checkNonEmpty(
  checkDimensionFields(dim({ last_flip: { date: '2026-07-15', evidence: 'some/other/path.mjs' } })),
  "a last_flip.evidence not present in the dimension's own evidence array is caught",
);
checkEmpty(
  checkDimensionFields(dim({ last_flip: { date: '2026-07-15', evidence: 'bench/DASHBOARD.md' } })),
  'a well-formed last_flip (date + evidence present in the evidence array) is valid - this is the first real flip (D5, dimension 2)',
);
checkEmpty(
  checkDimensionFields(dim({ field_verdict: 'lost-must-earn', evidence: [] })),
  'a weak verdict (lost-must-earn) with empty evidence is fine - conceding an axis needs no proof',
);
checkNonEmpty(
  checkDimensionFields(dim({ field_verdict: 'won-across-field', evidence: [] })),
  'a strong verdict (won-across-field) with empty evidence is caught - a claimed win needs a citation',
);

console.log('\n=== checkIdSet ===');
const FULL_IDS = ['1', '2', '3', '4', '5', '6', '7a', '7b', '8', '9', '10', '11', '12', '13'];
checkEmpty(checkIdSet(FULL_IDS), 'the exact declared 14-id set has no failures');
checkNonEmpty(checkIdSet(['1', '1', ...FULL_IDS.slice(2)]), 'a duplicate id is caught');
checkNonEmpty(checkIdSet(FULL_IDS.slice(0, -1)), 'a missing id is caught');
checkNonEmpty(checkIdSet([...FULL_IDS, '14']), 'an unexpected extra id is caught');

console.log('\n=== checkSchema (integration: the real bench/scoreboard.json as shipped) ===');
{
  const real = JSON.parse(readFileSync(path.join(REPO_ROOT, 'bench', 'scoreboard.json'), 'utf8'));
  checkEmpty(checkSchema(real), 'the real, currently-shipped scoreboard.json passes schema validation clean');
}

console.log('\n=== checkEvidenceExists ===');
{
  const tmp = mkdtempSync(path.join(tmpdir(), 'scoreboard-gate-test-'));
  const realFile = path.join(tmp, 'real-evidence.md');
  writeFileSync(realFile, 'placeholder evidence content\n');
  const docGood = { dimensions: [dim({ evidence: [path.relative(REPO_ROOT, realFile)] })] };
  const docBad = { dimensions: [dim({ evidence: [path.relative(REPO_ROOT, path.join(tmp, 'does-not-exist.md'))] })] };
  checkEmpty(checkEvidenceExists(docGood), 'an evidence path that exists on disk has no failures');
  checkNonEmpty(checkEvidenceExists(docBad), 'an evidence path that does not exist on disk is caught');
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== checkFlipCouplingPure ===');
{
  const evidencePath = 'docs/ROADMAP_2036.md';
  const baseDim3 = dim({ id: '3', evidence: [evidencePath] });

  // No baseline at all (origin/main has no scoreboard.json yet, or fetch failed): vacuously clean,
  // matching the real SKIP behavior in the git-facing wrapper.
  checkEmpty(
    checkFlipCouplingPure({ dimensions: [baseDim3] }, null, new Set()),
    'a null baseline (no origin/main history) produces no failures',
  );

  // New dimension, absent from the baseline entirely: exempt, nothing to flip from.
  checkEmpty(
    checkFlipCouplingPure(
      { dimensions: [dim({ id: '99', evidence: [evidencePath] })] },
      { dimensions: [baseDim3] }, // baseline has no id "99"
      new Set(),
    ),
    'a dimension absent from the baseline (brand new) is exempt from flip-coupling',
  );

  // Verdict unchanged: no failure regardless of what files changed.
  checkEmpty(
    checkFlipCouplingPure({ dimensions: [baseDim3] }, { dimensions: [baseDim3] }, new Set()),
    'an unchanged verdict produces no failure even with an empty changed-files set',
  );

  // Verdict changed (field_verdict), evidence path IS in the changed-files diff: coupled, no failure.
  checkEmpty(
    checkFlipCouplingPure(
      { dimensions: [dim({ id: '3', field_verdict: 'lost-must-earn', evidence: [evidencePath] })] },
      { dimensions: [baseDim3] },
      new Set([evidencePath]),
    ),
    'a field_verdict change coupled to a changed evidence file produces no failure',
  );

  // Verdict changed (python_verdict), evidence path IS in the changed-files diff: coupled, no failure.
  checkEmpty(
    checkFlipCouplingPure(
      { dimensions: [dim({ id: '3', python_verdict: 'subsumed', evidence: [evidencePath] })] },
      { dimensions: [baseDim3] },
      new Set([evidencePath]),
    ),
    'a python_verdict change coupled to a changed evidence file produces no failure',
  );

  // Verdict changed, evidence path NOT in the changed-files diff: not coupled, failure.
  checkNonEmpty(
    checkFlipCouplingPure(
      { dimensions: [dim({ id: '3', field_verdict: 'lost-must-earn', evidence: [evidencePath] })] },
      { dimensions: [baseDim3] },
      new Set(['some/unrelated/file.md']),
    ),
    'a verdict change NOT coupled to any changed evidence file is caught',
  );

  // note-only edit (both verdict fields identical): prose sharpening, must not demand evidence.
  checkEmpty(
    checkFlipCouplingPure(
      { dimensions: [dim({ id: '3', note: 'a reworded, sharper note' })] },
      { dimensions: [baseDim3] },
      new Set(), // nothing changed on disk, and nothing should be required to change
    ),
    'a note-only edit (verdict fields unchanged) triggers no flip-coupling requirement',
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
