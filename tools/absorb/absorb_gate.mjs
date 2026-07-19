#!/usr/bin/env node
// CI gate over every absorbed-kernel fixture: hermetic (no foreign runtime needed).
// For each examples/absorbed/fixtures/*.fixture.json this verifies (1) the absorbed .lm
// has not drifted since absorption (sha pin) and (2) the kernel still reproduces the
// frozen oracle outputs on every recorded input, through the current compiler. Any
// compiler or kernel change that alters an absorbed behavior turns this red.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFixture } from './absorb.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'examples', 'absorbed', 'fixtures');

async function main() {
  const files = fs.existsSync(FIXTURE_DIR)
    ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.fixture.json')).sort()
    : [];
  if (files.length === 0) {
    console.error('absorb_gate: no fixtures found under examples/absorbed/fixtures');
    process.exit(1);
  }
  let fail = 0;
  for (const f of files) {
    const r = await checkFixture(path.join(FIXTURE_DIR, f));
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${f}: ${r.detail}`);
    if (!r.ok) fail++;
  }
  console.log(`absorb_gate: ${files.length - fail}/${files.length} absorbed kernels verified against frozen oracle outputs`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('absorb_gate error: ' + e.message); process.exit(2); });
