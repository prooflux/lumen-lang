#!/usr/bin/env node
// Purity gate v0 (ROADMAP_2036 Arc 1, 90-day item 1).
//
// docs/MANIFESTO.md, section "100% self-contained", sets the air-gap test:
// could this toolchain be built and run, end to end, on a machine that
// contains nothing but Lumen itself and its named substrate? Today the
// answer is no: node/npm drive the harnesses, wabt (an npm package)
// assembles the WAT seed, and clang compiles emitted C. This script does
// not claim purity and does not fix that debt. It is a ratchet: it
// inventories every non-Lumen artifact on the toolchain path, pins the
// current debt in docs/PURITY_BASELINE.json, and fails the build the day
// that debt grows. Shrinking the debt is always welcome and re-pins the
// baseline lower. The debt is only ever driven down, one PR at a time,
// never allowed to grow by accident.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'docs', 'PURITY_BASELINE.json');

const SCAN_DIRS = ['seed', 'native', 'tools'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git']);
const EXCLUDE_FILE_NAMES = new Set(['package-lock.json']);
const EXCLUDED_EXTS = new Set(['.lm', '.wat', '.md', '.json']);

// Known-external binaries the pipeline invokes today. wabt is not spawned
// as a subprocess; it is an npm package imported for its WASM API, so it
// is tracked here as a dependency rather than a spawn target.
const KNOWN_EXTERNAL_BINARIES = [
  '/usr/bin/true',
  'clang',
  'node',
  'npm',
  'otool',
  'python3',
  'wabt (npm package, embedded WASM assembler/decoder, not spawned)',
];

// A new external binary can be introduced from any language on the toolchain path, not just
// .mjs. Each of these captures the first string argument of a subprocess/exec/system call in
// its language; anything captured that is not already baselined is flagged as a new external
// binary. The goal is to FLAG a new dependency, not to perfectly parse every call form, so the
// regexes are deliberately broad and a per-language "unresolved call" marker (below) catches
// the forms whose target is not a literal.
const SPAWN_TARGET_RES = {
  '.mjs': /(?:execFileSync|execSync|spawnSync|spawn|exec)\(\s*['"]([^'"]+)['"]/g,
  '.py': /(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.system|os\.popen|os\.exec\w+)\s*\(\s*\[?\s*(?:r|f|rb|b)?['"]([^'"]+)['"]/g,
  '.c': /(?:\bsystem|\bpopen|\bexecl|\bexeclp|\bexecle|\bexecv|\bexecvp|\bexecvpe|\bposix_spawn\w*)\s*\(\s*"([^"]+)"/g,
};
// If a subprocess/exec/system API is used but no literal target could be captured (e.g. the
// binary is a variable), the file is still flagged so the debt is never silently invisible.
// Match the bare module/API name, not just the dotted call form, so an aliased import
// (import subprocess as _sp; _sp.run(...)) cannot evade the presence check.
const SPAWN_API_PRESENT_RES = {
  '.py': /\bsubprocess\b|os\.system|os\.popen|os\.exec\w+/,
  '.c': /\b(?:system|popen|execl|execlp|execle|execv|execvp|execvpe|posix_spawn\w*)\s*\(/,
  '.mjs': /(?:execFileSync|execSync|spawnSync|spawn|exec)\s*\(/,
};

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILE_NAMES.has(entry.name)) continue;
      const ext = path.extname(entry.name);
      if (EXCLUDED_EXTS.has(ext)) continue;
      out.push(full);
    }
  }
}

function categoryFor(filePath) {
  const ext = path.extname(filePath);
  if (ext === '.mjs') return '.mjs';
  if (ext === '.py') return '.py';
  if (ext === '.c') return '.c';
  return 'other';
}

function buildInventory() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    walk(path.join(REPO_ROOT, dir), files);
  }
  const records = files
    .map((f) => {
      const rel = path.relative(REPO_ROOT, f).split(path.sep).join('/');
      const bytes = statSync(f).size;
      return { path: rel, bytes };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalsByCategory = { '.mjs': 0, '.py': 0, '.c': 0, other: 0 };
  const countByCategory = { '.mjs': 0, '.py': 0, '.c': 0, other: 0 };
  let totalBytes = 0;
  for (const r of records) {
    const cat = categoryFor(r.path);
    totalsByCategory[cat] += r.bytes;
    countByCategory[cat] += 1;
    totalBytes += r.bytes;
  }

  return {
    files: records,
    totals: {
      count: records.length,
      bytes: totalBytes,
      by_category: {
        '.mjs': { count: countByCategory['.mjs'], bytes: totalsByCategory['.mjs'] },
        '.py': { count: countByCategory['.py'], bytes: totalsByCategory['.py'] },
        '.c': { count: countByCategory['.c'], bytes: totalsByCategory['.c'] },
        other: { count: countByCategory.other, bytes: totalsByCategory.other },
      },
    },
  };
}

function scanSpawnTargets() {
  const dirs = ['seed', 'native', 'tools'];
  const found = new Set();
  for (const dir of dirs) {
    const full = path.join(REPO_ROOT, dir);
    const files = [];
    walk(full, files);
    for (const f of files) {
      const ext = path.extname(f);
      const re = SPAWN_TARGET_RES[ext];
      if (!re) continue;
      const src = readFileSync(f, 'utf8');
      let m;
      re.lastIndex = 0;
      let captured = false;
      while ((m = re.exec(src)) !== null) {
        found.add(m[1]);
        captured = true;
      }
      // A subprocess/exec/system API used with a non-literal target still counts as debt.
      const present = SPAWN_API_PRESENT_RES[ext];
      if (!captured && present && present.test(src)) {
        const rel = path.relative(REPO_ROOT, f).split(path.sep).join('/');
        found.add(`<unresolved subprocess/exec target in ${rel}>`);
      }
    }
  }
  return [...found].sort();
}

function currentHeadSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeBaseline(inventory, spawnTargets) {
  const baseline = {
    generated_from: currentHeadSha(),
    external_binaries: KNOWN_EXTERNAL_BINARIES,
    spawn_targets: spawnTargets,
    files: inventory.files,
    totals: inventory.totals,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

function main() {
  const pin = process.argv.includes('--pin');
  const inventory = buildInventory();
  const spawnTargets = scanSpawnTargets();

  if (pin) {
    const baseline = writeBaseline(inventory, spawnTargets);
    console.log(`purity_gate: baseline pinned at HEAD ${baseline.generated_from}`);
    console.log(
      `purity_gate: ${baseline.totals.count} files, ${baseline.totals.bytes} bytes`,
    );
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error('purity_gate: FAIL - no baseline found at docs/PURITY_BASELINE.json');
    console.error('purity_gate: run `node tools/purity_gate.mjs --pin` to create one');
    process.exit(1);
  }

  const baselineByPath = new Map(baseline.files.map((f) => [f.path, f.bytes]));
  const currentByPath = new Map(inventory.files.map((f) => [f.path, f.bytes]));

  const newFiles = [];
  const grownFiles = [];
  const shrunkFiles = [];
  const removedFiles = [];

  for (const [p, bytes] of currentByPath) {
    if (!baselineByPath.has(p)) {
      newFiles.push({ path: p, bytes });
    } else {
      const before = baselineByPath.get(p);
      if (bytes > before) grownFiles.push({ path: p, before, after: bytes, delta: bytes - before });
      else if (bytes < before) shrunkFiles.push({ path: p, before, after: bytes, delta: before - bytes });
    }
  }
  for (const [p, bytes] of baselineByPath) {
    if (!currentByPath.has(p)) removedFiles.push({ path: p, bytes });
  }

  const baselineBinaries = new Set(baseline.external_binaries || []);
  const baselineSpawnTargets = new Set(baseline.spawn_targets || []);
  const newSpawnTargets = spawnTargets.filter((t) => !baselineSpawnTargets.has(t));

  const growthFailures = newFiles.length > 0 || grownFiles.length > 0 || newSpawnTargets.length > 0;

  if (growthFailures) {
    console.error('purity_gate: FAIL - toolchain debt grew relative to docs/PURITY_BASELINE.json');
    if (newFiles.length > 0) {
      console.error('  new files not in baseline:');
      for (const f of newFiles) console.error(`    + ${f.path} (${f.bytes} bytes)`);
    }
    if (grownFiles.length > 0) {
      console.error('  files grown beyond their baselined size:');
      for (const f of grownFiles) {
        console.error(`    ~ ${f.path}: ${f.before} -> ${f.after} bytes (+${f.delta})`);
      }
    }
    if (newSpawnTargets.length > 0) {
      console.error('  new external binary referenced (execFileSync/spawn target):');
      for (const t of newSpawnTargets) console.error(`    + ${t}`);
    }
    process.exit(1);
  }

  if (shrunkFiles.length > 0 || removedFiles.length > 0) {
    console.log('purity_gate: debt SHRANK. Re-pin the smaller baseline:');
    console.log('  node tools/purity_gate.mjs --pin');
    for (const f of shrunkFiles) {
      console.log(`    - ${f.path}: ${f.before} -> ${f.after} bytes (-${f.delta})`);
    }
    for (const f of removedFiles) {
      console.log(`    - ${f.path}: removed (was ${f.bytes} bytes)`);
    }
  }

  console.log(
    `purity_gate: PASS - ${inventory.totals.count} files, ${inventory.totals.bytes} bytes, ` +
      `no growth vs baseline pinned at ${baseline.generated_from}`,
  );
}

main();
