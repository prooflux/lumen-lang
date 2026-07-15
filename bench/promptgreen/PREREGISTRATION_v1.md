# Promptgreen preregistration v1: rounds-to-solved, Lumen versus Python

Status: this document fixes the hypotheses, endpoints, shard design, and analysis plan BEFORE
any real-model number exists. Per this repo's own standing discipline (two prior false "beats
C" claims are in `SELFHOST_CAMPAIGN_LOG.md`'s history on purpose, kept as evidence, not
embarrassment) and per `docs/ROADMAP_2036.md`'s Arc 1 exit gate ("the promptgreen rig produces
its first honest Lumen-versus-Python numbers, whatever they say"), no real-model run against
the sealed shard below may happen until this file is committed. Deviating from this plan after
seeing data is not a refinement, it is the exact failure mode this document exists to prevent.
This document changes no code and flips no scorecard verdict; it is prose and statistics only.

## Scope of v1 (interim, read this before the headline claim)

This registers the CURRENT 10-task repo scale as interim only, of which 8 are held-out and
statistically counted; the other 2 are the dev shard, not counted (see Shard design below for
why the split is 8-and-2 rather than all 10). `docs/LUMEN_UNIVERSAL_COVERAGE_PLAN.md` section
4's target is >= 100 frozen tasks; that scale gets its own v2 registration once the corpus
grows (WP-promptgreen). At n=8, a ONE-SIDED Wilcoxon's best-case exact p-value (all 8 pairs
favor Lumen, no ties) is (1/2)^8 ~= 0.0039 (not the two-sided `2 x (1/2)^8 ~= 0.0078` this
document's own math carried over from an earlier, two-sided draft and never re-derived when
the primary test changed to one-sided; corrected here), so alpha=0.05 is technically reachable,
but only for a large, near-unanimous effect; this design has essentially no power to detect a
modest one. A confirmed H1 here is an honest interim signal at n=8, not the production "beats Python"
claim, which needs the >= 100-task, Arc 3-scale rig. Say this out loud so nobody downstream
quotes v1's n=8 as if it were that rig.

## Hypotheses

- **H1 (primary).** For a fixed pinned model at temperature 0 (or the provider's minimum),
  under the equal-context configuration (defined below), rounds-to-solved for
  Lumen-plus-spec-bundle is lower than rounds-to-solved for Python, on the sealed shard.
- **H2 (secondary).** Under the same design, tokens-to-solved for Lumen-plus-spec-bundle is
  lower than for Python, counting the spec bundle's own tokens against Lumen (defined below).
- **H3 (secondary).** The diagnostic-feedback lift, defined as
  `solved-by-round-5 minus solved-by-round-1` (the fraction of additional tasks the feedback
  loop recovers between the first and last attempt), is positive for both arms AND larger for
  Lumen than for Python. This is a claim about the VALUE of Lumen's structured diagnostics as a
  repair signal, not just about raw speed: it is possible for Lumen to win H1 while losing H3,
  or vice versa, and both results are reported regardless of which way either falls.

None of these are claims about legacy-familiarity or human ergonomics; they are claims about
this specific pinned model, this sealed shard, this context configuration, on this date.

## Definitions

- **Green.** The candidate compiles with zero diagnostics (`compiled.ok === true` in
  `bench/promptgreen/runner.mjs`). Green is necessary, not sufficient.
- **Solved (`green_solved`).** Green AND the task's `hidden_tests.mjs` reports `green: true`
  (the program is actually correct, not merely diagnostic-free). All three hypotheses are about
  solved, never about green alone; a candidate that compiles clean but produces the wrong
  answer is not solved.
- **Cap.** `ROUND_CAP = 5` (`bench/promptgreen/runner.mjs`). A task that never solves within the
  cap is cap-censored. Cap-censored observations are recorded AT the cap value (5) for
  rounds-to-solved, never dropped from the dataset and never left null; a task solved exactly on
  round 5 and a task never solved both read 5 in the primary analysis, which is a real
  limitation stated plainly: this convention cannot distinguish "solved just in time" from
  "never solved," and is applied identically to both arms so it cannot itself manufacture a
  direction. A supplementary table reports the raw censoring rate per arm so a reader can judge
  how much of a rounds-to-solved result rests on ties at the cap versus genuine early solves.
- **Tokens-to-solved.** Counted by a pinned offline tokenizer, `js-tiktoken`'s `o200k_base`
  encoding, exact package version recorded per run. This tokenizer is not present in this repo
  today; pinning it is WP-promptgreen item P3, a prerequisite for this document's H2 to be run,
  not a retroactive relabeling of the current chars/4 placeholder in `runner.mjs` (that
  placeholder is explicitly not a real token count and is never substituted for one). Each
  provider's own reported native token usage is logged alongside every attempt for reference,
  but the registered H2 endpoint is always the offline tokenizer's count, never the provider's,
  so the metric cannot silently drift if a provider changes its counting.
- **One-shot-solved.** Boolean: solved on round 1.
- **Solved-rate-at-cap.** Boolean per task: solved by round 5 (equivalently, not cap-censored).

## Endpoints and tests

- **Primary: rounds-to-solved.** Per-task median across N=5 runs (see below) is the unit paired
  by task across arms. Wilcoxon signed-rank test, ONE-SIDED (the hypothesis is directional by
  construction: H1 claims Lumen needs fewer rounds, not merely a different number), alpha =
  0.05. Effect size: the ratio of medians, `median(Python) / median(Lumen)`, so a ratio > 1
  favors Lumen. 95% CI via paired bootstrap: resample the task-pairs with replacement, B =
  10,000 resamples, percentile method. H1 is supported only if ALL of: (a) the one-sided
  Wilcoxon p < 0.05, (b) the point estimate of the ratio is > 1, (c) the 95% CI excludes 1.0
  entirely on the favors-Lumen side. Any other combination does not support H1, including a
  significant one-sided p-value whose CI still straddles 1.0 (that combination is treated as
  inconclusive, not confirmed, and is reported as such).
- **Secondary: tokens-to-solved (H2).** Same paired design, same test construction (one-sided
  Wilcoxon, ratio-of-medians effect size, bootstrap CI), reported on equal footing with the
  primary once the pinned tokenizer exists. Not multiplicity-corrected against the primary; a
  significant H2 does not itself flip any scorecard verdict, only H1 does, per the disposition
  rules below.
- **Secondary: one-shot-solved rate.** Paired binary outcome per task. McNemar's exact test
  (binomial form, not the chi-square approximation, given the small expected count of
  discordant pairs at n=8), alpha = 0.05, on the discordant pairs only.
- **Secondary: solved-rate-at-cap.** Same construction as one-shot-solved rate (paired binary,
  McNemar's exact test), evaluated at round 5 instead of round 1: does the task ever solve
  within budget, regardless of how many rounds it took.
- **H3 (diagnostic-feedback lift).** For each arm, compute `solved-rate-at-cap minus
  one-shot-solved-rate` (the fraction of tasks the feedback loop alone recovers). H3 is
  supported if this lift is positive for both arms (feedback helps at all) and the Lumen lift
  exceeds the Python lift. Reported descriptively with the per-arm lift values and their
  difference; given the sample size this is not claimed at a formal significance level, and is
  labeled exploratory rather than confirmatory.

## N=5, temperature 0 (or provider minimum)

Five independent completions per (task, round, arm, config). Temperature 0 does not guarantee
bit-identical output from most hosted model APIs (batching effects and non-associative
floating-point reduction on the serving side are the usual causes); if a provider does not
expose temperature 0, its documented minimum is used and recorded. Per task, the reported
rounds-to-solved and tokens-to-solved are the MEDIAN across the 5 repetitions, computed once per
task before any paired test runs; the 5 raw repetitions are never individually paired into the
Wilcoxon or McNemar tests, which would pseudo-replicate by treating non-independent repeats of
the same task as independent observations. The full spread (min, median, max) across the 5
repetitions is reported per task as a diagnostic of how deterministic the pinned model actually
is in practice.

## Arms and context fairness

Two comparisons, both run, both reported:

- **Config A: Lumen-plus-spec-bundle vs Python-bare.** Lumen receives its full spec bundle
  (`FOR_LLMS.md` and the machine-readable spec) in context; Python receives only the task spec,
  no additional grounding. This is the realistic-as-deployed comparison; it does not isolate the
  language effect from the context effect, and is not the headline claim on its own.
- **Config B: Lumen-plus-spec-bundle vs Python-plus-equal-size-reference.** Lumen still
  receives its spec bundle; Python receives an equivalently sized, equivalently purposed excerpt
  of official Python documentation for the features the task exercises. **The headline claim
  (H1) must hold in Config B, not only Config A, to be reported as supported**: a win that
  appears only in Config A is evidence the spec bundle itself is doing the work, not the
  language, and is reported as exactly that rather than folded into the headline.
- **Bundle tokens count against Lumen.** The spec bundle's own token cost is included in
  Lumen's tokens-to-solved (H2); Lumen pays for its own grounding rather than getting it for
  free, so a win cannot be manufactured by handing Lumen an uncounted advantage.
- **Fixed diagnostic byte budget.** Both arms receive the same maximum bytes of feedback per
  round (the compiler's structured diagnostic for Lumen; the interpreter's traceback and error
  text for Python), truncated identically if either would exceed it, so neither arm gets a
  systematically richer feedback channel by virtue of one language's error messages being
  longer or shorter in general.

This section constrains the harness that WP-promptgreen's P4 (Python arm) must build; no Python
arm exists in this tree today (`bench/promptgreen/README.md`'s own "No Lumen-vs-X comparison"
limitation), so Config A and Config B are both design commitments the harness is built against,
not yet a running check.

## Shard design

- **Dev shard (public, iteration).** Used to debug the harness, the author-integration, and the
  prompting before any sealed run. Never contributes an observation to H1, H2, or H3.
- **Held-out shard (the primary evaluation set): `t03` through `t10`, n=8, interim,** drawn from
  today's repo total of 10 tasks (`t01` through `t10`; the other 2 are the dev shard above; see
  the honesty note below for why the split is 8-and-2 rather than sealing all 10). Sealed by a
  SHA-256 hash over a tarball of the held-out task directories, committed here before any run:
  ```
  held_out_sha256 = f857f95825a4ce979af65c7a68e9964404428649ce2c3a03fcf930aec3828383
  ```
  computed and verified against `t03` through `t10` (8 of the 10; see the honesty note below for
  why this v1 seal does not yet cover `t01`/`t02`) while writing this document, over the sorted
  list of each task's `spec.md`, `reference.lm`, and `hidden_tests.mjs`, each entry hashed as
  `relative_path + NUL + file_bytes + NUL`, concatenated in path-sorted order. Any future change
  to a held-out task's spec, reference, or hidden test produces a different hash and requires a
  new, explicitly versioned seal; a hash mismatch at run time means the shard drifted or was
  tampered with and the run does not count.
  **Honesty note on what "sealed" can mean here:** `t01` through `t10` are already public,
  committed to this git repository's history. A hash proves TAMPER-EVIDENCE (nothing changed
  after this commit), not TRUE BLIND HELD-OUT (content hidden from any evaluator, including a
  model whose training data might include a scrape of this public repo, until scoring). This
  v1 registration is honest about that limit rather than claiming a stronger guarantee than it
  has: genuine held-out sealing needs tasks written after this document lands and kept out of
  the public tree until reveal, which is out of scope for today's already-public 10 and is
  named as v2 work, alongside the >= 100-task scale-up. Given that, this v1 seal is drawn over
  `t03` through `t10` (the 8 non-trivial tasks) as the evaluation set that matters most for a
  meaningful ratio; `t01`/`t02` (the two simplest, one-round tasks) are folded into the dev
  shard instead of the held-out one, since their triviality gives them the least power to
  discriminate and the most exposure to the already-public-content caveat above.
- **Metamorphic shard (planned, 0 tasks today).** Derived from the held-out shard by
  semantics-preserving transforms (renamed identifiers, reordered independent statements, an
  equivalent spec phrasing) with regenerated hidden tests verified against each task's own
  `reference.lm`, one variant per held-out task as the initial plan, sealed with its own hash
  before any metamorphic-specific run.
- **Claims gate on held-out AND metamorphic.** H1 is not reported as supported on held-out
  results alone; the metamorphic shard must be built, sealed, and run before H1 is called
  confirmed. A Python-favoring gap between held-out and metamorphic performance (Lumen's
  apparent lead shrinking or reversing on the semantically-equivalent but differently-phrased
  variants) is reported explicitly as the fingerprint of a memorized-idiom advantage on the
  exact sealed phrasing rather than genuine problem-solving, whichever arm it appears in.

### The public-leakage vector, stated plainly

(a) The seal above proves immutability (the tasks were not modified after this hash was
computed) and lets a reader detect selection bias (no task was added or dropped after seeing
results); it does not, and cannot, claim the tasks are unseen by any model. This repository is
public, and the sealed tasks together with their `reference.lm` solutions have been in git
history since before this document existed.

(b) Because the reference solutions are public, verbatim or near-verbatim regurgitation by the
pinned model is possible in principle. This is the dangerous direction, not the safe one: it
would inflate the Lumen arm specifically, since Python's solutions are not drawn from this
repo, biasing H1, H2, and H3 toward confirming the hypothesis rather than away from it. A
confirmed H1 that is actually memorization, not genuine authorship, is worse than an honest
null, because it would be believed.

(c) The metamorphic shard (semantics-preserving transforms of the held-out tasks, with
regenerated hidden tests) is the control for exactly this: a model that memorized the sealed
phrasing rather than the underlying problem should measurably underperform on its metamorphic
sibling. It does not exist yet, which is one more reason v1 is a pilot and not the production
claim (see Scope above).

(d) Until the metamorphic control exists, the v1 disposition adds one rule: any Lumen solution
suspiciously close to its task's `reference.lm` is flagged and reported alongside the headline
number, never silently folded into a plain win. "Suspiciously close" is fixed now, before any
run: normalized Levenshtein edit distance (edit distance divided by the longer of the two
source lengths in characters) below 0.15, i.e. 85% or more character-level similarity to the
reference, computed on the raw submitted source. No formatter exists yet to canonicalize
whitespace first (`lumen fmt` is Arc 2 batteries work, not shipped today), which is itself a
known limitation of this crude check, stated rather than hidden. A flagged solution does not by
itself falsify H1; it is reported as a caveat on whichever result it touches, with the count of
flagged solutions stated directly beside the headline ratio.

## Falsifiers

H1 is falsified by any of: the one-sided Wilcoxon p-value is >= 0.05; the bootstrap 95% CI on
the ratio-of-medians includes 1.0; the point estimate of the ratio is <= 1 (Python matches or
beats Lumen); the majority of held-out tasks are cap-censored in both arms, which would mean
the shard is too hard for the pinned model to say anything about either language at this
budget. Any one of these on its own is a falsification.

## Disposition rules

Fixed now, applied mechanically once the run completes, per this repo's own standing discipline
9 (a verdict flips only in the PR that lands its gate, and that PR moves the scoreboard, the
ledger, and the row prose together):

- **H1 confirmed (on held-out AND metamorphic, per the gating rule above).**
  `bench/scoreboard.json` dimensions 9 and 13 move in the PR that reports the number,
  `docs/VELOCITY_LEDGER.md` gets a new entry, and `VISION_2036.md` / `LANGUAGE_COMPARISON.md`
  row 9 (and row 13, which the scoreboard's own note already ties to the same loop) update in
  that same PR, per `tools/scoreboard_gate.mjs --check`'s flip-coupling rule. Reported as an
  interim, n=8 signal, not the Arc 3 production claim.
- **H1 falsified (Python wins, or the CI includes 1.0).** The measured ratio is published
  exactly as measured, machine-written into `bench/DASHBOARD.md`, with no re-run and no
  post-hoc task exclusion. `bench/scoreboard.json` dimension 9 (`field_verdict: lost-must-earn`,
  `python_verdict: winnable-gated-open`) and dimension 13 (`field_verdict: lost-must-earn`,
  `python_verdict: subsumed`) are unchanged: this is already the honest present-tense verdict
  for both, so a loss needs no scorecard or prose edits to absorb it, and none are made. The result is recorded in `SELFHOST_CAMPAIGN_LOG.md` (or its successor living
  log) either way, win or loss, so the attempt is not quietly dropped from the record.
- **Inconclusive.** Reported as inconclusive with the specific falsifier that fired stated
  plainly. Disposition is to grow the shard or ease task difficulty before the next attempt,
  itself a new preregistration, never to relax the cap or the test after seeing the data.
- **Any result, either direction.** `docs/ROADMAP_2036.md` Arc 3's own kill criterion (no
  measurable authorship gain by end-2029) is the only thing that retires this bet, and is
  unaffected by any single v1 result in either direction.

## Model pinning

Not named in this document; inventing a specific model id here would be exactly the kind of
unverified claim this document exists to prevent. The exact model identifier is recorded per
attempt (not once per run), and the run aborts on any detected pin drift mid-run (the model
identifier changing between attempts) rather than continuing with mixed-model data; a drifted
run is discarded and repeated under the corrected, re-recorded pin. `docs/ROADMAP_2036.md`
Arc 1 specifies "a pinned open-weight model" without naming one in this tree; the specific
model is pinned in a follow-up addendum committed before the sealed run, never after.

## Addendum 1 (2026-07-15, committed before any real-model run): the metamorphic shard exists and is sealed

The metamorphic shard this document planned at 0 tasks now exists: `m03` through `m10`, one
variant per held-out task, authored by a fanned-out factory (one author per two variants, one
adversarial verifier per variant) applying all four registered transforms: every identifier and
record field renamed, every constant re-parameterized with expected outputs recomputed from
scratch, the spec fully paraphrased, and hidden tests regenerated for the new constants. Each
variant was verified the same way as a base task (compiles and runs green, hidden tests pass on
the reference and fail on a mutant, spec language-neutral, Python twin matching). `m10` uses the
raw-memory intrinsics its source `t10` uses; the shipped-surface check was scored against the
source's own surface. `runner.mjs`'s `t\d+` discovery deliberately does not match the `m`
prefix, so the shard contributes no observation to any run until the metamorphic-specific run
this document requires, which must verify the seal below first.

Seal, same recipe as the held-out shard with one disambiguation the v1 text left implicit:
`relative_path` means the path from the REPOSITORY ROOT (for example
`bench/promptgreen/tasks/m03/spec.md`); the v1 held-out hash reproduces under exactly this
convention and was re-verified while computing this one. Over each variant's `spec.md`,
`reference.lm`, and `hidden_tests.mjs`, entries `relative_path + NUL + file_bytes + NUL`
concatenated in path-sorted order:

```
metamorphic_sha256 = c163b6b7f2dbd957c46cff7f9af90a89818a88c0182c5783c87d064ebd4fb0b2
```

The same tamper-evidence honesty note applies: these files are public from this commit onward;
the seal proves nothing changed after sealing, not that a model never saw them. Their defense
against regurgitation is the transforms themselves, which is the entire reason this shard
exists.

## Where this sits

`bench/promptgreen/README.md` describes the harness this registration constrains.
`docs/LUMEN_UNIVERSAL_COVERAGE_PLAN.md` section 4 is Pillar A, the target this v1 pilot serves.
`docs/ROADMAP_2036.md` Arc 1's exit gate ("the promptgreen rig produces its first honest
Lumen-versus-Python numbers, whatever they say") and Arc 3's full-protocol target (100+ tasks,
hidden tests, control languages, published logs) bound this document on both sides: Arc 1 is
why v1 exists at interim scale now, Arc 3 is the scale at which its result becomes the
production claim and gets its own v2 registration. `RULES.md` supplies the metric names this
document inherits rather than redefines. `bench/scoreboard.json` dimensions 9 and 13 and their
`gate` fields are what this document's disposition rules actually update, and no earlier than
the PR that reports the real number.
