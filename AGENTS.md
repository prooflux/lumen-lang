# Agent instructions for this repo

This file is for any AI agent (Claude Code, Codex, or otherwise) working directly in this
checkout. It exists because a full session of parallel agents working this repo (2026-07-22/23)
each rediscovered the same operational facts from scratch, at real time and token cost, and one
real regression (a Bool-typing change breaking `examples/http/handlers_demo.lm`) slipped onto
`main` because no agent ran the actual full CI gate list, only a hand-remembered subset. Read this
file first; it is shorter than re-deriving all of this empirically.

## The one invariant that must never break

`native/native_fixpoint_test.mjs` proves a generation-2 compiler, built from the native pipeline's
own C output, is byte-identical to generation-1. If your change breaks this, it is not landable,
full stop, regardless of anything else it accomplishes. See `ARCHITECTURE.md` for what this means.

## Run the gates: one command, not a memory exercise

```sh
node tools/gate_all.mjs            # --full: the exact sequence .github/workflows/gate.yml runs
node tools/gate_all.mjs --quick    # a fast local sanity net only (seed npm test + native_diff +
                                    # native_fixpoint_test) - NOT a substitute for --full or for
                                    # the real `gate` GitHub Actions check
node tools/gate_all.mjs --install  # force npm install in seed/ and native/ first
```

Do not hand-assemble the gate list from memory or from an old prompt/skill file. `gate.yml` runs
~50 checks across 5 jobs (scoreboard, seed+effects, ~40 native scripts, promptgreen selftest,
absorb gate); a partial list feels complete and is not. `tools/gate_all.mjs` IS that list,
transcribed mechanically - if you edit `gate.yml`, keep `tools/gate_all.mjs`'s step list in sync.

**Typical wall-clock time (idle machine, no contention): full gate run is several minutes**, most
of it `native_fixpoint_test.mjs` (rebuilds two full compiler generations from native C) and the
~40-script native gates step. This is normal, not a hang. See the concurrency note below for why it
can take much longer.

## Do not background-wait and quit - block on the command

Three separate agent sessions this week ended their own turn by starting a background `Monitor` /
poll-loop watching a long-running gate and then reporting something like "I'll wait for the
notification" - which is not a valid way to finish a task delegated to you. There is no external
notification that resumes a stopped turn on its own. If a gate is slow, that is expected (see
above); call it as a single blocking command with a generous timeout and wait for it yourself.

## Concurrency: this repo's full gate run is expensive, and this machine has felt it

Running more than one full `gate_all.mjs`/native-rebuild pass at once on this machine has
repeatedly caused 5-10x slowdowns from CPU contention, and separately, memory pressure from many
concurrent Node processes has caused test processes to sit alive for 10+ minutes after printing a
correct PASS summary (OS-level process-teardown stall, not a code bug, confirmed reproducible).
`tools/gate_all.mjs` writes an advisory lockfile and warns if another run already holds it; respect
that warning rather than piling on. If you are one of several agents working this repo in parallel,
each in your own clone (see below), stagger full gate runs rather than firing them all at once.

## Landing changes: PR required, `gate` must be green - no more direct pushes to main

**Branch protection on `main` now requires the `gate` status check to pass before any update to
main is accepted** (added 2026-07-23, in direct response to the regression above landing via a
bare `git push origin main` that only ran a local, incomplete gate subset). This applies even to
the repo owner (`enforce_admins: true`). Concretely:

- A bare `git push origin main` for a fresh commit will be rejected: GitHub only accepts an update
  to a protected branch with a required check when that check has already passed for that exact
  commit, which a brand-new local commit has never had a chance to do.
- Land changes via PR: `git push -u origin <branch>`, `gh pr create`, wait for `gate` to go green
  (or use `tools/land_pr.mjs <pr-number>` to merge locally with a full gate run first, then push
  the resulting fast-forward - see that script's header for exactly what it does and does not do).
- The existing `auto-merge.yml` workflow squash-merges any PR the moment its `gate` run succeeds,
  with no manual approval required (open a PR as a Draft to opt out). This is unaffected by branch
  protection; it is exactly the intended path.
- One language/feature change per PR, per the project's existing convention (see `RULES.md`).

## Working in parallel: clone, don't worktree

If you are one of several agents working this repo at once, each should work in an independent
`git clone` of this repo into its own directory (not a `git worktree` - shared worktree admin dirs
have caused orphaned/corrupted state elsewhere in this user's other repos, and clones sidestep
that entirely). Push your branch, open a PR, let `gate` run. Do not edit the same working directory
another agent is using concurrently.

## Known gotchas (empirically confirmed, not theoretical)

- **`lumenc.lm`'s 70000-byte `SRC_CAPACITY` window is a real, hard limit**, not a soft guideline:
  the self-hosted compiler must fit inside it to compile itself. A feature addition that pushes it
  over triggers `lumen: memory trap: source exceeds the 70000-byte SRC window` and fails the
  self-hosting gate. If you're close to the limit, condense comments before adding logic; the fix
  history has real precedent (a historical memory-map comment block trimmed from ~2949 to ~1650
  bytes to make room, `edf014f`'s predecessor commits).
- **Orphaned `--resident` compiler processes accumulate if a test run is interrupted.** Nothing
  reaps them automatically outside of the specific gates `native/reap_residents.mjs` is wired into
  (PR #105). If you see many long-lived `lumenc0 --resident` processes in `ps aux`, that's this;
  `node native/reap_residents.mjs` cleans them by age.
- **`text_eq` (and comparisons, `and`/`or`/`not`) return `Bool`, not `Int`**, since the bool-type
  PR (#104). `Bool` never coerces to/from `Int`; `if some_predicate() == 1` is now a type error if
  `some_predicate` returns `Bool` (it is fine if the function is declared `-> Int` and explicitly
  returns `0`/`1` itself - only the four retyped builtins/operators are affected). Grep for
  `text_eq(...) == [01]` and comparison-chained `== [01]` after touching anything Bool-adjacent.
- **`docs/EFFECTS_BASELINE.json`'s purity-fraction ratchet (`tools/effects_gate.mjs`) is a real,
  blocking CI gate**, not advisory (do not confuse it with `tools/purity_gate.mjs`, which IS
  advisory-only toolchain-debt tracking - a different, similarly-named thing). Adding
  example/test code that is net-impure (e.g. a function that prints) can regress the fraction below
  baseline. Fix by adding genuinely pure functions exercising the same feature, not by editing the
  baseline (that is a project-policy decision, not a mechanical one).

## Where things live (see also ARCHITECTURE.md and LANGUAGE.md)

- `tools/gate_all.mjs` - the full gate suite, one command.
- `tools/land_pr.mjs <pr-number>` - fetch, merge locally, gate, push - the careful merge protocol.
- `tools/absorb/` - oracle-gated absorption of foreign (Python, C, C++) functions.
- `bench/vs-lang/` - matched-kernel timings against real C, Rust, and Python.
- `native/lumend_native.mjs` - the persistent native-compiler daemon (warm process over a socket).
- `.claude/skills/lumen/SKILL.md` in the QUANTS repo is the parallel front door for Claude Code
  sessions whose working directory is QUANTS, not this repo (they cannot auto-load this file);
  keep the operational facts here and there from drifting apart when either changes.
