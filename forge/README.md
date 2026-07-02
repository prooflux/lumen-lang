# Lumen Forge: 5-Path Differential Compiler Testing

## Overview

The Forge is a **self-growing test corpus** for the Lumen compiler. It generates deterministic, type-directed random Lumen programs, runs each through 5 independent compilation/execution paths, and captures divergences as **findings** (potential bugs). The corpus grows as findings are triaged, minimized, fixed, and promoted to a **regression floor** that prevents regressions.

## The 5 Execution Paths

Each generated program is compiled and executed by:

| Path | Name | What It Does | Role |
|------|------|-------------|------|
| **a** | **INTERP** | Compile + run on the seed compiler (wasm interpreter) | Reference oracle (ground truth) |
| **b** | **SELFHOST-IR** | Self-hosted: lumenc.lm (running on seed VM) compiles the same program; IR diffed word-for-word vs path a | Self-hosting validation |
| **c** | **OPT** | Optimize the IR from path a, re-run it; stdout/exit vs path a | Optimizer correctness |
| **d** | **C** | Compile to C via native/pipeline.mjs, execute | Native backend (C) correctness |
| **e** | **LLVM** | Compile to LLVM IR via native/pipeline.mjs, execute | Native backend (LLVM) correctness |

Paths d and e only run on every `--native-every N`-th seed (default N=20) because native compilation is expensive.

## Commands

```bash
# Validate generator + harness (smoke test)
npm test

# Run forge on a seed range (smoke: 200 seeds, native-every 50)
npm run smoke

# Large campaign (20,000 seeds, native-every 20)
npm run campaign

# Direct forge invocation (full control)
node forge.mjs --from 1 --to 1000 [--native-every 20] [--out findings.jsonl]
```

**CLI Arguments:**

- `--from N` (required): Start seed number
- `--to N` (required): End seed number (inclusive)
- `--native-every N` (default 20): Run paths d+e every N-th seed to save time
- `--out FILE` (default `findings.jsonl`): Write findings to this JSONL file (one JSON object per line)

## Grammar Scope

### V1 (Currently Supported)

The genprog generator (genprog.mjs) covers:

- **Types:** `Int`, `Float`, `Text`
- **Expressions:** Literals, variable references, function calls
- **Statements:** `let` and `var` declarations, assignments, `if`/`else` conditionals, `print` statements, function definitions
- **Functions:** User-defined functions with Int/Float/Text parameters and return types
- **Control Flow:** Conditional branches, early returns

### V2 (Excluded; Documented Here)

The following types/constructs are intentionally out of scope. See the comment in the codebase for the reason:

| Construct | Why Excluded | Gap |
|-----------|--------------|-----|
| **Sum Types** (enums, tagged unions) | Self-host lexer gap | lumenc.lm lexer cannot parse variant constructors; seed compiler can. |
| **Record Types** (structs, named tuples) | Self-host lexer gap | lumenc.lm lexer cannot parse record syntax; seed compiler can. |
| **Arrays** | LLVM array-op gap | native/pipeline.mjs buildAndRunLlvm does not emit correct array indexing operations; seed/C backends work. |

When V2 support is added, each construct will get a new phase of testing that exercises it on all 5 paths. Until then, genprog avoids generating these constructs to keep the corpus homogeneous and ensure every finding is actionable.

## Finding Lifecycle

Findings flow through a state machine as they are discovered, triaged, minimized, and fixed:

```
┌──────────────┐
│   pending/   │  Newly discovered finding
├──────────────┤
│  - NAME.lm   │  Minimized repro (original size before reduction)
│  - NAME.json │  Metadata: seed, class, originalSize, reducedSize
└──────────────┘
       ↓
   (triage: is this a real bug or a known false positive?)
       ↓
   (reduce: minimize the repro via reduce.mjs)
       ↓
   (fix: engineer commits a fix)
       ↓
   (verify: run forge_corpus_test to ensure fix holds)
       ↓
┌──────────────┐
│    fixed/    │  Regression repro (now passing all 5 paths)
├──────────────┤
│  - NAME.lm   │  Minimized repro (committed to prevent regression)
└──────────────┘
```

**State Files:**

- `forge_corpus/pending/` - Minimized repros of open bugs, not yet fixed. The corpus test (`forge_corpus_test.mjs`) **reports** these (seed/class/size) but does **not** assert; this test stays green while known issues are queued.
- `forge_corpus/fixed/` - Minimized repros of bugs that have since been fixed. The corpus test **asserts** none of these diverge; a failure means a fix regressed.

**Honesty Rule:**

A finding is a **discovery**, reported verbatim, never silenced. If forge produces a finding during testing (`npm test` or `npm run smoke`), it means real divergence was detected:

- Real findings are printed clearly (stdout shows seed/class/detail)
- They remain in `.forge_test_run*.jsonl` for inspection
- They are **not** treated as test failures (forge_test.mjs stays green)
- The human must triage: is it a legitimate bug, or a known limitation?

This honesty prevents "ghost bugs" that silently disappear after cleanup.

## Program Generation

**genprog.mjs** generates type-directed random Lumen-μ programs:

- Deterministic: `genprog(seed=42)` always produces the same bytes
- Diverse: 500-seed runs typically produce 450+ unique programs
- Valid: All generated programs compile clean (gen_test.mjs asserts this)
- Controlled randomness: Uses seeded xorshift64star, not Math.random or Date

Generated programs are simple (no V2 constructs) so findings are minimizable and fixable quickly.

## Test Harness (forge_test.mjs)

Self-test for the forge runner:

1. **Baseline run** (seeds 1..40, native-every 10): forge must complete
2. **Determinism**: Two runs produce identical findings (byte-for-byte)
3. **Fault injection** (FORGE_FAULT=10): Injecting a fault must produce exactly one finding (validates detection works)

Any real findings surfaced **without** FORGE_FAULT set are discoveries, printed clearly, left in the output.

## Regression Floor (forge_corpus_test.mjs)

Validates that fixed bugs stay fixed:

- **fixed/** files: Must pass all 5 paths (asserted)
- **pending/** files: Reported as known open issues (not asserted; test stays green)

A regression in fixed/ causes the test to fail immediately, blocking merges.

## Reducing Findings

**reduce.mjs** minimizes a failing program:

```bash
node reduce.mjs --program <LUMEN_SRC> --class <DIVERGENCE_CLASS> \
  [--from-seed N] [--output reduced.lm]
```

Reduction uses binary search + structural simplification to shrink the repro while preserving the divergence. Output is committed to `pending/` with a sidecar JSON file containing metadata (original size, reduced size, seed, class).

## Workflow

1. **Generate**: genprog produces seed N
2. **Run**: forge runs all 5 paths, captures any divergences
3. **Discover**: A finding is logged (seed, class, detail)
4. **Inspect**: Engineer reads the finding details and generated program
5. **Reduce**: Minimize the repro via reduce.mjs → `forge_corpus/pending/`
6. **Triage**: Is this a real bug or a known limitation?
7. **Fix**: Engineer fixes the compiler bug in seed/ or native/
8. **Verify**: Run forge_corpus_test to ensure the fixed repro no longer diverges
9. **Promote**: Move `pending/NAME.lm` → `fixed/NAME.lm` (remove the JSON sidecar)

## CI Integration

The Forge is **not** wired into CI/seed/package.json or GitHub Actions. Manager decides the policy:

- **Blocking runs** (e.g., every PR to seed/ must stay green under `npm run smoke`)?
- **Daily campaign** (`npm run campaign` via cron)?
- **On-demand** (engineers run locally when investigating)?

See the manager's deployment doc for CI integration.

## Design Notes

- **Determinism**: All randomness is seeded; same input always yields same output.
- **Honesty**: Findings are reported verbatim, never suppressed. The test stays green even if findings appear.
- **Regression floor**: The fixed/ corpus is the contract: never regress on these bugs.
- **Minimization**: Reduced repros (pending/) make bugs easier to understand and fix.
- **5-path coverage**: Tests interpreter, self-host, optimizer, and two native backends; finds compiler bugs across all layers.
