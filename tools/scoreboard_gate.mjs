#!/usr/bin/env node
// scoreboard_gate.mjs - the living-scoreboard gate for the 14-language field campaign.
//
// bench/scoreboard.json is the machine-readable single source of truth for the per-dimension
// verdicts LANGUAGE_COMPARISON.md and VISION_2036.md carry in prose. This script has two modes:
//
//   node tools/scoreboard_gate.mjs --check    # BLOCKING: schema, ids, enums, evidence, flip-coupling
//   node tools/scoreboard_gate.mjs --render   # regenerate the AUTO:scoreboard block in bench/DASHBOARD.md
//
// --check enforces the campaign's own honesty gate mechanically: a verdict may not change without
// at least one of its cited evidence files ALSO changing in the same diff against origin/main (so a
// verdict cannot be bumped by editing JSON alone; the artifact that earns it has to land in the
// same changeset). This mirrors tools/purity_gate.mjs's baseline-diff idiom (a pinned JSON compared
// against the live tree) and reuses tools/architecture-update.mjs's `<!-- AUTO:name -->` splice
// convention for --render (same marker syntax used in ARCHITECTURE.md, applied here to
// bench/DASHBOARD.md). Zero new dependencies: plain Node stdlib, exactly like its two ancestors.
//
// --check never touches bench/DASHBOARD.md; --render never validates the scoreboard's own schema
// beyond what it needs to build the table. Keep the two modes independent so a CI failure always
// points at exactly one cause.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SCOREBOARD_PATH = path.join(REPO_ROOT, 'bench', 'scoreboard.json');
const DASHBOARD_PATH = path.join(REPO_ROOT, 'bench', 'DASHBOARD.md');

const STALENESS_DAYS = 100;

// The declared vocabularies. python_verdict comes from VISION_2036.md's own scorecard (Lumen vs
// Python alone); field_verdict comes from LANGUAGE_COMPARISON.md's scorecard (Lumen vs the
// fourteen-language field). They are deliberately different enums because the two docs score
// different comparisons - do not merge them.
const PYTHON_VERDICTS = new Set(['won-by-design', 'winnable-gated-open', 'subsumed']);
const FIELD_VERDICTS = new Set([
  'won-across-field', 'won-contested', 'structural-opening',
  'lost-must-earn', 'split', 'aspiration-contested',
]);
// field_verdicts at or below "aspiration" are conceding the axis rather than claiming a landed
// artifact, so they are the only ones exempt from the evidence-path requirement below.
const WEAK_FIELD_VERDICTS = new Set(['aspiration-contested', 'lost-must-earn']);

// The declared id set for the current 13-dimension scorecard, with dimension 7 split into 7a/7b
// per LANGUAGE_COMPARISON.md's own two-part text (row 11 stays a single entry; see its "note").
// Update this list in the same PR that changes the doc's dimension count or splits.
const EXPECTED_IDS = ['1', '2', '3', '4', '5', '6', '7a', '7b', '8', '9', '10', '11', '12', '13'];

function loadScoreboard() {
  if (!existsSync(SCOREBOARD_PATH)) {
    console.error('scoreboard_gate: FAIL - bench/scoreboard.json not found');
    process.exit(1);
  }
  const raw = readFileSync(SCOREBOARD_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`scoreboard_gate: FAIL - bench/scoreboard.json is not valid JSON: ${e.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// --check: schema (incl. ids + enums), evidence-exists, flip-coupling, staleness (advisory).
// ---------------------------------------------------------------------------

function checkSchema(doc) {
  const failures = [];
  if (typeof doc.updated_commit !== 'string' || !doc.updated_commit) {
    failures.push('updated_commit missing or not a string');
  }
  if (typeof doc.updated_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.updated_date)) {
    failures.push('updated_date missing or not YYYY-MM-DD');
  }
  if (!Array.isArray(doc.dimensions)) {
    failures.push('dimensions is not an array');
    return failures;
  }

  const seenIds = new Set();
  for (const dim of doc.dimensions) {
    const tag = `dimension ${dim && dim.id !== undefined ? dim.id : '<unknown>'}`;
    if (typeof dim.id !== 'string') {
      failures.push(`${tag}: id must be a string`);
      continue;
    }
    if (seenIds.has(dim.id)) failures.push(`duplicate id: ${dim.id}`);
    seenIds.add(dim.id);

    if (typeof dim.name !== 'string' || !dim.name) failures.push(`${tag}: name missing`);

    if (dim.python_verdict !== null && !PYTHON_VERDICTS.has(dim.python_verdict)) {
      failures.push(`${tag}: python_verdict "${dim.python_verdict}" not in {${[...PYTHON_VERDICTS].join(', ')}, null}`);
    }
    if (!FIELD_VERDICTS.has(dim.field_verdict)) {
      failures.push(`${tag}: field_verdict "${dim.field_verdict}" not in {${[...FIELD_VERDICTS].join(', ')}}`);
    }
    if (!Array.isArray(dim.evidence)) {
      failures.push(`${tag}: evidence must be an array`);
    } else if (dim.field_verdict && !WEAK_FIELD_VERDICTS.has(dim.field_verdict) && dim.evidence.length === 0) {
      failures.push(`${tag}: field_verdict "${dim.field_verdict}" is stronger than aspiration/lost and requires at least one evidence path`);
    }
    if (dim.last_flip !== null) {
      failures.push(`${tag}: last_flip must be null (not yet tracked as of this scoreboard's introduction)`);
    }
  }

  const expected = new Set(EXPECTED_IDS);
  const missing = EXPECTED_IDS.filter((id) => !seenIds.has(id));
  const extra = [...seenIds].filter((id) => !expected.has(id));
  if (missing.length) failures.push(`missing declared ids: ${missing.join(', ')}`);
  if (extra.length) failures.push(`ids present but not in the declared set (update EXPECTED_IDS if this is intentional): ${extra.join(', ')}`);

  return failures;
}

function checkEvidenceExists(doc) {
  const failures = [];
  for (const dim of doc.dimensions || []) {
    for (const p of dim.evidence || []) {
      if (!existsSync(path.join(REPO_ROOT, p))) {
        failures.push(`dimension ${dim.id}: evidence path does not exist: ${p}`);
      }
    }
  }
  return failures;
}

function tryGitShow(ref, relPath) {
  try {
    return execSync(`git show ${ref}:${relPath}`, {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// A dimension "flips" when either verdict field differs from the origin/main baseline. A flip is
// only trusted if at least one of the dimension's evidence paths also changed in this same diff -
// otherwise the verdict moved without the artifact that would justify it.
function checkFlipCoupling(doc) {
  try {
    execSync('git fetch origin main --depth=1', { cwd: REPO_ROOT, stdio: 'ignore' });
  } catch {
    console.log('scoreboard_gate: flip-coupling SKIP - could not fetch origin/main (offline or no remote); not failing on this check');
    return [];
  }

  const baselineRaw = tryGitShow('origin/main', 'bench/scoreboard.json');
  if (baselineRaw === null) {
    console.log('scoreboard_gate: flip-coupling SKIP - bench/scoreboard.json does not exist on origin/main yet (first landing)');
    return [];
  }

  let baseline;
  try {
    baseline = JSON.parse(baselineRaw);
  } catch {
    console.log('scoreboard_gate: flip-coupling SKIP - origin/main bench/scoreboard.json failed to parse');
    return [];
  }

  const baselineById = new Map((baseline.dimensions || []).map((d) => [d.id, d]));
  let changedFiles;
  try {
    changedFiles = new Set(
      execSync('git diff --name-only origin/main', { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean),
    );
  } catch {
    changedFiles = new Set();
  }

  const failures = [];
  for (const dim of doc.dimensions || []) {
    const before = baselineById.get(dim.id);
    if (!before) continue; // new dimension: nothing to flip from, exempt
    const flipped = before.python_verdict !== dim.python_verdict || before.field_verdict !== dim.field_verdict;
    if (!flipped) continue;
    const coupled = (dim.evidence || []).some((p) => changedFiles.has(p));
    if (!coupled) {
      failures.push(
        `dimension ${dim.id}: verdict changed (python: ${before.python_verdict} -> ${dim.python_verdict}, ` +
        `field: ${before.field_verdict} -> ${dim.field_verdict}) but none of its evidence paths changed vs ` +
        `origin/main: ${(dim.evidence || []).join(', ') || '(no evidence listed)'}`,
      );
    }
  }
  return failures;
}

function checkStaleness(doc) {
  if (typeof doc.updated_date !== 'string') return;
  const updated = new Date(`${doc.updated_date}T00:00:00Z`);
  if (Number.isNaN(updated.getTime())) return;
  const days = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24));
  if (days > STALENESS_DAYS) {
    console.log(
      `scoreboard_gate: ADVISORY - scoreboard is ${days} days old (updated_date ${doc.updated_date}), ` +
      `past the ${STALENESS_DAYS}-day staleness threshold. Not blocking.`,
    );
  }
}

// ---------------------------------------------------------------------------
// --render: splice a compact table into bench/DASHBOARD.md's <!-- AUTO:scoreboard --> block.
// ---------------------------------------------------------------------------

const label = (v) => (v === null || v === undefined ? '-' : String(v));

function renderTable(doc) {
  const header = '| ID | Dimension | vs Python | vs Field | Wave | Arc | Note |\n' +
                 '|----|-----------|-----------|----------|------|-----|------|';
  const rows = doc.dimensions.map((d) => {
    const note = (d.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const shortNote = note.length > 160 ? `${note.slice(0, 157)}...` : note;
    return `| ${d.id} | ${d.name} | ${label(d.python_verdict)} | ${label(d.field_verdict)} | ` +
           `${label(d.wave)} | ${label(d.arc)} | ${shortNote} |`;
  });
  return [header, ...rows].join('\n');
}

function spliceBlock(text, name, body) {
  const re = new RegExp(`(<!-- AUTO:${name} -->)[\\s\\S]*?(<!-- /AUTO:${name} -->)`);
  return re.test(text) ? text.replace(re, `$1\n${body}\n$2`) : null;
}

function render(check) {
  const doc = loadScoreboard();
  const table = renderTable(doc);
  const original = readFileSync(DASHBOARD_PATH, 'utf8');

  let updated = spliceBlock(original, 'scoreboard', table);
  if (updated === null) {
    // First run: bench/DASHBOARD.md has no AUTO:scoreboard block yet (its existing D1-D20 domain
    // table is written directly by bench/d15_finance_bench.mjs and is untouched here). Append a
    // new section carrying the markers.
    const withMarkers = `${original.replace(/\n*$/, '\n')}\n` +
      '## The 13-dimension field scorecard (auto-rendered)\n\n' +
      'Rendered from `bench/scoreboard.json` by `tools/scoreboard_gate.mjs --render`. Do not hand-edit ' +
      'the block between the markers below; edit `bench/scoreboard.json` and re-render instead.\n\n' +
      `<!-- AUTO:scoreboard -->\n${table}\n<!-- /AUTO:scoreboard -->\n`;
    updated = withMarkers;
  }

  if (updated === original) {
    console.log('scoreboard_gate: bench/DASHBOARD.md scoreboard block is up to date.');
    return;
  }
  if (check) {
    console.error('scoreboard_gate: FAIL - bench/DASHBOARD.md scoreboard block is STALE. Run: node tools/scoreboard_gate.mjs --render');
    process.exit(1);
  }
  writeFileSync(DASHBOARD_PATH, updated);
  console.log(`scoreboard_gate: bench/DASHBOARD.md scoreboard block refreshed (${doc.dimensions.length} dimensions).`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const doCheck = args.includes('--check');
  const doRender = args.includes('--render');

  if (!doCheck && !doRender) {
    console.error('Usage: node tools/scoreboard_gate.mjs --check | --render [--check]');
    process.exit(1);
  }

  if (doRender) {
    // --render alone writes bench/DASHBOARD.md in place. --render --check verifies the AUTO
    // block is already up to date and fails without writing (the architecture-update.mjs idiom,
    // applied to this script's own artifact) - not wired into gate.yml today, but available.
    render(doCheck);
    return;
  }

  const doc = loadScoreboard();
  const failures = [
    ...checkSchema(doc),
    ...checkEvidenceExists(doc),
    ...checkFlipCoupling(doc),
  ];
  checkStaleness(doc); // advisory only; never contributes to failures or exit code

  if (failures.length > 0) {
    console.error(`scoreboard_gate: FAIL - ${failures.length} issue(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`scoreboard_gate: PASS - ${doc.dimensions.length} dimensions, schema/ids/evidence/flip-coupling all clean.`);
}

main();
