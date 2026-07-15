// latency_shootout_selftest.mjs (S3) - deterministic self-test for compile_latency_bench.mjs's
// PURE functions: the G9 byte-identical-stdout comparator, median math, spawn-cost clamp, row
// rendering, and AUTO-block splice idempotency. NO timing assertions ("X must run in under Yms")
// - wall-clock numbers are inherently noisy, same philosophy as bench/kernel_suite_selftest.mjs.
//
// Wired into .github/workflows/gate.yml's "promptgreen rig selftest" step, alongside
// kernel_suite_selftest.mjs.
//
// Run: node bench/latency_shootout_selftest.mjs

import {
  median,
  subtractSpawnCost,
  checkG9,
  renderRow,
  renderTable,
  spliceAutoBlock,
} from './compile_latency_bench.mjs';

let fail = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); fail++; }
}

// ---------------------------------------------------------------------------
// median()
// ---------------------------------------------------------------------------
check(median([1, 2, 3, 4, 5]) === 3, 'median: sorted odd-length array picks the true middle');
check(median([5, 1, 4, 2, 3]) === 3, 'median: unsorted array sorts before picking the middle');
check(median([42]) === 42, 'median: single-element array returns that element');
check(median([1, 1, 1, 2, 3]) === 1, 'median: duplicate values handled correctly');
{
  let threw = false;
  try { median([]); } catch { threw = true; }
  check(threw, 'median: throws on an empty array rather than returning undefined/NaN silently');
}

// ---------------------------------------------------------------------------
// subtractSpawnCost()
// ---------------------------------------------------------------------------
check(subtractSpawnCost(10, 5) === 5, 'subtractSpawnCost: normal case subtracts cleanly');
check(subtractSpawnCost(5, 5) === 0, 'subtractSpawnCost: raw equal to spawn cost floors at zero');
check(subtractSpawnCost(3, 5) === 0, 'subtractSpawnCost: raw BELOW spawn cost floors at zero, never negative');
check(subtractSpawnCost(0, 0) === 0, 'subtractSpawnCost: zero/zero is zero, not NaN or negative');

// ---------------------------------------------------------------------------
// checkG9(): the byte-identical-stdout comparator that gates the whole run.
// ---------------------------------------------------------------------------
{
  const identical = { lumen: 'abc\n', c: 'abc\n', go: 'abc\n', java: 'abc\n', python: 'abc\n' };
  const r = checkG9(identical);
  check(r.ok === true, 'checkG9: identical outputs across all five twins -> ok');
  check(r.mismatches.length === 0, 'checkG9: identical outputs -> zero mismatches reported');
}
{
  const mismatched = { lumen: 'abc\n', c: 'abc\n', go: 'ABC\n', java: 'abc\n', python: 'abc\n' };
  const r = checkG9(mismatched);
  check(r.ok === false, 'checkG9: a single differing twin -> not ok');
  check(r.mismatches.length === 1 && r.mismatches[0] === 'go', 'checkG9: names exactly the mismatching twin, not a vague failure');
}
{
  const empty = {};
  const r = checkG9(empty);
  check(r.ok === true, 'checkG9: empty input (nothing to compare) is trivially ok, not a false failure');
}
{
  // whitespace/newline-sensitive: this is a BYTE comparison, not a trimmed/normalized one.
  const trailing = { a: 'x\n', b: 'x' };
  const r = checkG9(trailing);
  check(r.ok === false, 'checkG9: a missing trailing newline counts as a real mismatch (byte-exact, not trimmed)');
}

// ---------------------------------------------------------------------------
// renderRow() / renderTable(): deterministic, and the null/note case renders honestly instead
// of "NaN ms" or a fabricated number.
// ---------------------------------------------------------------------------
{
  const row = { date: '2026-01-01', tier: 'cold check', lang: 'lumen', ms: 1.2345 };
  const line = renderRow(row);
  check(line.includes('lumen'), 'renderRow: language name present');
  check(line.includes('1.23') || line.includes('1.24'), 'renderRow: ms rendered with fixed precision');
  check(!line.includes('NaN') && !line.includes('undefined'), 'renderRow: no NaN/undefined leakage on a normal row');
}
{
  const notInstalledRow = { date: '2026-01-01', tier: 'cold check', lang: 'rust', ms: null, note: 'not installed on this machine' };
  const line = renderRow(notInstalledRow);
  check(line.includes('not installed on this machine'), 'renderRow: a missing toolchain renders its honest note, not a fabricated number');
  check(!line.includes('NaN') && !line.includes('undefined'), 'renderRow: absent-toolchain row has no NaN/undefined leakage');
}
{
  const naRow = { date: '2026-01-01', tier: 'warm', lang: 'go', ms: null, note: 'N/A (no supported resident daemon)' };
  const line = renderRow(naRow);
  check(line.includes('N/A (no supported resident daemon)'), 'renderRow: no-daemon languages render the explicit N/A note');
}
{
  const rows = [
    { date: '2026-01-01', tier: 'cold check', lang: 'lumen', ms: 1 },
    { date: '2026-01-01', tier: 'cold check', lang: 'go', ms: 2 },
  ];
  const table = renderTable(rows);
  check(table.includes('| Date | Tier |'), 'renderTable: header row present');
  check(table.includes('lumen') && table.includes('go'), 'renderTable: both data rows present');
  check(renderTable(rows) === table, 'renderTable: deterministic - same input twice produces byte-identical output');
}

// ---------------------------------------------------------------------------
// spliceAutoBlock(): create-on-first-use, additive accumulation, empty-splice idempotence,
// single marker pair never duplicated - mirrors kernel_suite_bench.mjs's own splice tests.
// ---------------------------------------------------------------------------
{
  const bare = '# Some Dashboard\n\nSome unrelated content.\n';
  const row1 = { date: '2026-01-01', tier: 'cold check', lang: 'lumen', ms: 1 };
  const firstSplice = spliceAutoBlock(bare, 'latency-shootout', [row1]);
  check(firstSplice.includes('<!-- AUTO:latency-shootout -->'), 'spliceAutoBlock: creates the AUTO marker block on first use');
  check(firstSplice.includes('<!-- /AUTO:latency-shootout -->'), 'spliceAutoBlock: creates the closing AUTO marker');
  check(firstSplice.includes('lumen'), 'spliceAutoBlock: first row present after initial splice');
  check(firstSplice.includes('Some unrelated content.'), 'spliceAutoBlock: pre-existing document content is preserved, not clobbered');

  const reSplicedEmpty = spliceAutoBlock(firstSplice, 'latency-shootout', []);
  check(reSplicedEmpty === firstSplice, 'spliceAutoBlock: re-splicing with no new rows is a true no-op (idempotent)');
  const reSplicedEmptyAgain = spliceAutoBlock(reSplicedEmpty, 'latency-shootout', []);
  check(reSplicedEmptyAgain === firstSplice, 'spliceAutoBlock: idempotence holds across repeated empty re-splices');

  const row2 = { date: '2026-01-02', tier: 'cold check', lang: 'go', ms: 2 };
  const secondSplice = spliceAutoBlock(firstSplice, 'latency-shootout', [row2]);
  check(secondSplice.includes('lumen'), 'spliceAutoBlock: accumulation preserves the earlier dated row');
  check(secondSplice.includes('go'), 'spliceAutoBlock: accumulation adds the new dated row');

  const openCount = (secondSplice.match(/<!-- AUTO:latency-shootout -->/g) || []).length;
  const closeCount = (secondSplice.match(/<!-- \/AUTO:latency-shootout -->/g) || []).length;
  check(openCount === 1 && closeCount === 1, 'spliceAutoBlock: exactly one marker pair survives repeated splicing, never duplicated');
}

console.log(fail === 0 ? '\nlatency_shootout_selftest: all checks passed.' : `\nlatency_shootout_selftest: ${fail} failure(s).`);
process.exit(fail === 0 ? 0 : 1);
