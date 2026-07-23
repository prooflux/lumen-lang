// land_pr.mjs - the careful, repeatable protocol for merging a PR into main, as one command.
//
// Why this exists (2026-07-23): landing a PR this session meant hand-typing the same ~15-line
// git/gh dance every time (fetch, checkout main, merge --no-ff, run the full gate suite, push or
// reset --hard on failure), and it was easy to skip a step or bail into a background-wait pattern
// mid-way. This script IS that protocol. It does not replace GitHub's own `gate` required status
// check (branch protection on main requires that regardless), it exists so LOCAL verification
// before you even open/merge the PR is complete and consistent, and so merging is one command
// instead of an agent re-deriving the sequence from memory each time.
//
// Usage:
//   node tools/land_pr.mjs <pr-number> [--quick]
//
// What it does, in order:
//   1. Fetches origin, checks out main, fast-forwards to origin/main.
//   2. Fetches and merges the PR's head branch into a LOCAL main (not pushed yet).
//   3. Runs gate_all.mjs (--full by default; --quick only for a fast sanity pass on something
//      you already trust, e.g. a doc-only PR - the real `gate` check still gates the merge on
//      GitHub's side regardless of which mode you pick here).
//   4. On success: pushes local main to origin (fast-forward; if this fails because origin moved,
//      it aborts and tells you to re-run rather than force-pushing).
//   5. On failure: resets local main back to the pre-merge commit, leaves the PR unmerged, and
//      prints the exact failing step so you know what to fix before trying again.
//
// This does not merge via GitHub's own merge API (gh pr merge) by design: pushing the merge
// commit directly to main is what makes the local gate run you just did the same code that lands,
// rather than the PR head branch (which could have moved since you last looked at it).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [, , prArg, ...rest] = process.argv;
const quick = rest.includes('--quick');

if (!prArg || !/^\d+$/.test(prArg)) {
  console.error('usage: node tools/land_pr.mjs <pr-number> [--quick]');
  process.exit(2);
}
const pr = prArg;

function sh(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { cwd: REPO, shell: true, stdio: 'inherit', ...opts });
  return r.status === 0;
}

function shCapture(cmd) {
  const r = spawnSync(cmd, { cwd: REPO, shell: true, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

function fail(msg) {
  console.error(`\nland_pr: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  if (!sh('git fetch origin')) return fail('git fetch failed');
  if (!sh('git checkout main')) return fail('git checkout main failed');
  if (!sh('git pull --ff-only')) return fail('git pull --ff-only failed (local main has diverged?)');

  const preMerge = shCapture('git rev-parse HEAD').out;

  const branchInfo = shCapture(
    `gh pr view ${pr} --repo lumen-source/lumen --json headRefName -q .headRefName`,
  );
  if (!branchInfo.ok || !branchInfo.out) return fail(`could not resolve head branch for PR #${pr}`);
  const branch = branchInfo.out;

  console.log(`PR #${pr} -> branch ${branch}`);
  if (!sh(`git fetch origin ${branch}`)) return fail(`could not fetch origin/${branch}`);
  if (!sh(`git merge --no-ff origin/${branch} -m "Merge PR #${pr} (${branch})"`)) {
    sh(`git merge --abort`);
    return fail(
      `merge conflict merging origin/${branch} into main. Resolve by hand (do not blindly ` +
      `pick one side - read both diffs), then re-run this script, or finish the merge and ` +
      `gate manually.`,
    );
  }

  const gateCmd = `node tools/gate_all.mjs ${quick ? '--quick' : '--full'}`;
  if (!sh(gateCmd)) {
    console.error(`\nland_pr: gate failed. Resetting main back to ${preMerge} (pre-merge). PR #${pr} NOT merged.`);
    sh(`git reset --hard ${preMerge}`);
    process.exitCode = 1;
    return;
  }

  if (!sh('git push origin main')) {
    return fail(
      `push failed (origin/main moved since step 1?). main is fast-forwarded locally with the ` +
      `merge already gate-verified; re-run 'git pull --rebase' manually and push, or re-run this ` +
      `script from scratch rather than force-pushing.`,
    );
  }

  const sha = shCapture('git rev-parse HEAD').out;
  console.log(`\nland_pr: PR #${pr} merged to origin/main at ${sha}.`);
}

main();
