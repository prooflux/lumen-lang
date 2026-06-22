# The AI-Authorship Feedback Loop

Status: draft v0.1.

Lumen is written by AI, used by AI, and, distinctively, **continuously improved from the measured experience of the AI writing it**. Most languages evolve from human complaints in issue trackers. Lumen adds a structured, always-on channel where the AI author (Claude, and any other agent) reports its authoring experience as data, and that data drives language, diagnostic, and tooling changes. The goal stated by the project owner: tune Lumen to the maximum of Claude's capabilities, and keep it tuned as those capabilities change.

This is the second flywheel. The first (in `COMMUNITY.md`) is adoption: structured diagnostics make agents productive, which grows the ecosystem. This one is improvement: the agent's friction is measured and fed back, so the language gets easier and safer for the agent to author over time.

```
Claude authors Lumen
   -> the toolchain measures the experience (friction, rounds-to-green, ambiguity)
   -> Claude emits structured feedback on what helped and what did not
   -> triage maps feedback to a language/diagnostic/tooling change (RFC)
   -> the change ships in a new edition
   -> the authorship benchmark re-runs and confirms the change helped
   -> Claude authors Lumen better. Repeat.
```

Everything below is structured data, because that is what makes the loop automatable rather than anecdotal.

---

## 1. The author-feedback record

The unit of feedback is a structured record. Because Lumen is excellent at structured data, a feedback record is itself representable as a Lumen value (the language dogfoods its own data model). The schema:

```
AuthorFeedback {
  author:        { agent: Text, model: Text },     # e.g. "claude", "claude-opus-4-8"
  task:          { id: Text, description: Text },   # what was being built
  subject:       Subject,                           # what the feedback is about
  category:      Category,
  severity:      Low | Medium | High,
  rounds_to_green: Int,                             # compile-fix cycles this construct cost
  expected:      Text,                              # what the agent expected to be valid/clear
  actual:        Text,                              # what actually happened
  suggestion:    Text,                              # proposed change to language/diagnostic/tooling
  span:          Option<Span>,                      # source location, if applicable
}

Subject =
  | Construct(name: Text)        # e.g. "match-exhaustiveness", "capability-passing"
  | DiagnosticCode(code: Text)   # e.g. "E0210"
  | StdlibItem(path: Text)       # e.g. "list.fold"
  | Tooling(tool: Text)          # e.g. "fmt", "lsp", "debugger"

Category =
  | Friction        # correct but harder to generate than it should be
  | Ambiguity       # more than one plausible way to express this; had to guess
  | MissingFix      # a diagnostic that should have carried a confident fix but did not
  | Surprise        # behavior or rule that violated a reasonable expectation
  | Suggestion      # a concrete proposed improvement
  | Praise          # this worked well; do not regress it
```

`Praise` matters as much as the negatives: it marks ergonomics that must not be lost in a future change. A regression in something that worked is a real cost.

---

## 2. How feedback is produced (continuous, low-friction)

Two sources, one passive and one active.

### 2.1 Passive: authoring telemetry

When an agent compiles and corrects Lumen through the toolchain, the toolchain can record (locally, opt-in) the signals that indicate friction without the agent having to say anything:

- which diagnostic codes fired, and how often,
- how many compile-fix rounds it took to reach green,
- which constructs were edited repeatedly before they compiled,
- where a diagnostic offered no confident fix and the agent had to reason from prose,
- token cost of the program relative to a reference solution (an efficiency signal).

These become aggregate `AuthorFeedback` records of category `Friction` or `MissingFix`, attributed to the construct or diagnostic code involved. No human writes them; they fall out of normal use.

### 2.2 Active: the agent reports deliberately

The agent can also emit a record on purpose, through the Claude Code `/lumen` skill or `lumen feedback`. This is for the judgments telemetry cannot infer: "I expected `else if` to be a keyword and it is not" (`Ambiguity`), "the capability-passing pattern is verbose for deeply nested calls" (`Suggestion`), "exhaustive match saved me here, keep it" (`Praise`).

The `/lumen` skill is built so that emitting a feedback record is a single cheap action the agent is prompted to take whenever it hits friction, so feedback is continuous rather than a once-a-release event.

### 2.3 Privacy and trust

Feedback is local-first and opt-in. By default only aggregate, non-identifying signals (diagnostic-code frequencies, rounds-to-green distributions, construct names) leave the machine; source code is not exfiltrated unless the author explicitly shares a minimized reproduction. The loop must be trustworthy or it will be turned off, which would defeat it.

---

## 3. The Claude-authorship benchmark (making "max for Claude" measurable)

"Tune Lumen to the maximum of Claude's capabilities" is only real if it is measured. The benchmark, under `bench/authorship/`, is a growing corpus of programming tasks (from one-liners to small programs) with reference solutions and tests. For a given model, the harness has the model author each task in Lumen and records:

| Metric | What it captures |
|--------|------------------|
| First-try compile rate | fraction of tasks that compile on the first attempt |
| Mean rounds-to-green | average compile-fix cycles to a passing solution |
| Correctness | fraction whose output matches the reference and passes tests |
| Token efficiency | tokens to a correct solution vs the reference |
| Diagnostic hit map | which diagnostics fire most during authoring |

These numbers are the definition of "how well Lumen fits Claude right now". A language or diagnostic change is judged by its effect on them.

### 3.1 The regression gate

A proposed change that **lowers** the first-try compile rate or **raises** mean rounds-to-green for Claude is flagged in review. Making the language harder for the AI to author correctly is treated as a regression, exactly as a performance regression would be. This is the concrete mechanism by which the language stays tuned to the AI rather than drifting away from it.

### 3.2 Tracking capability change over time

Models improve and change. The benchmark is re-run per model version, and the results live in a versioned `CLAUDE_CAPABILITY_PROFILE.md`: the observed strengths and failure modes of the current model, and the language and tooling responses to them (for example, if a model drifts on deeply nested delimiters, the formatter and lints can discourage deep nesting, and the grammar can keep nesting shallow). When a new model lands, the profile is refreshed and the language adapts. "Max for Claude" is not a one-time tuning; it is a standing target the loop tracks.

---

## 4. From feedback to change (triage)

Raw feedback is noise until it is triaged. The pipeline:

1. **Aggregate.** Group records by subject (construct, diagnostic code, stdlib item, tool) and category. A construct with many `Friction` records and a high rounds-to-green is a hot spot.
2. **Rank.** Order hot spots by total measured cost (frequency times severity times rounds-to-green).
3. **Diagnose.** For each top hot spot, decide the lever: a clearer diagnostic, a missing confident fix, a small syntax change, a stdlib addition, a formatter rule, or an LSP hint.
4. **Propose.** Open an RFC (or, for a pure diagnostic-text or fix improvement, a tracked diagnostic-registry change that does not need a full RFC).
5. **Ship and verify.** Land it in a new edition where it is breaking, then re-run the authorship benchmark to confirm the metrics moved the right way. If they did not, revert.

Most improvements will be diagnostics: a better message, or a confident fix that was missing. Those are cheap, high-leverage, and do not change the language. Syntax and semantic changes are rarer and go through the full RFC and editions process so existing code keeps compiling.

---

## 5. Why determinism makes this loop sound

The benchmark and the triage both depend on Lumen's determinism (DESIGN.md and DEBUGGABILITY.md). Because a Lumen program's behavior and its diagnostics are reproducible, a benchmark result is a stable measurement, not a flaky one, and a feedback record about "this failed" can be reproduced exactly from the recorded inputs. Determinism is what lets the improvement loop be a measured engineering process instead of a collection of anecdotes.

---

## 6. The community version

What starts as "improve Lumen for Claude" generalizes. Every agent that authors Lumen contributes friction data and feedback records. Lumen becomes the first language whose evolution is driven by measured AI-authoring ergonomics across many agents, with the regression gate ensuring changes help authors rather than hurt them. Humans contribute through the same RFC process; their issues and the agents' structured feedback feed one triage queue. The language gets steadily easier and safer to author, for AI and humans alike, because the cost of authoring it is continuously measured and continuously reduced.

---

## 7. Roadmap placement

This loop starts early and cheaply:

- The `AuthorFeedback` schema and the `bench/authorship/` corpus can be defined during Phase 0 and 1 (they are spec and data, not compiler internals).
- Passive telemetry attaches once the front end and diagnostics exist (Phase 1 to 2).
- The regression gate becomes meaningful once programs run (Phase 3) and is wired into the benchmark from then on.
- The `/lumen` Claude Code skill ships alongside the first usable toolchain (Phase 5) and is the primary active-feedback vehicle.

The loop is not a late add-on. It is part of how Lumen is built from the first phase, which is the point: the language is shaped by the AI's experience of writing it from the very beginning.
