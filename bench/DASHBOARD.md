# Lumen Universal Scoreboard & KPI Dashboard

## Aggregate Scorecards

- **Coverage**: 1 / 20 domains covered (requires passing G1–G8 across all standard operations in a domain).
- **Execution Speed**: 5% domains >= honest baseline at accuracy bound.
- **Pillar A (Prompt-to-Green)**:
  - Median Rounds Ratio (Lumen / Python): **TBD**
  - One-Shot-Green Rate: **TBD**
- **Pillar B (Compiler Speed)**:
  - 1,200 LOC Cold Compile: **0.5 ms** (100% of target)
  - 1,200 LOC Incremental Compile: **1.5 ms** (100% of target)
  - Compiler Throughput: **794.1 kLOC/sec** (Target: >100 kLOC/sec)
- **Pillar C (Execution Speed)**:
  - Quantitative Finance Flagship (D15): **TBD**
- **Honesty Gate Integrity**: **100%** of reported numbers pass automated gates (G1–G8).

---

## Scoreboard Table

| Domain/Pillar | Metric | Lumen | Honest Baseline | Ratio | Accuracy (Max ULP / exact) | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **D1: Elementary & Special** | Throughput (vols map) | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | In Progress |
| **D2: Dense Linear Algebra** | GEMM Throughput | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D3: Sparse Linear Algebra**| SPMV GFLOP/s | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D4: FFT & Signal** | FFT transforms/sec | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D5: Numerical Calculus** | Integration speed | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D6: Probability & Stats** | Distribution CDF speed | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D7: RNG** | Samples/sec | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D8: Optimization** | LP/QP solve time | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D9: Autodiff** | AD pricing overhead | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D10: Tensors & ML** | Softmax/layer latency | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D11: BigNum** | Karatsuba multiply | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D12: Symbolic Algebra** | Simplify/derive rate | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D13: Interval Arithmetic** | Enclosure tightness | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D14: APL Array Verbs** | Moving average speed | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D15: Quant Finance** | BS pricing vols/sec | 125.3M | 83.7M | 1.50x | < 57918168 ULP | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| **D16: Crypto Math** | EC point mult/sec | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D17: Geometry** | Predicates speed | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D18: Graphs** | Dijkstra search/sec | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D19: Dataframe Relational**| Group-by/join speed | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |
| **D20: GPU/Parallel** | Multi-threaded map | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Not Started |

---
*Last Updated: 2026-06-30*

## The 13-dimension field scorecard (auto-rendered)

Rendered from `bench/scoreboard.json` by `tools/scoreboard_gate.mjs --render`. Do not hand-edit the block between the markers below; edit `bench/scoreboard.json` and re-render instead.

<!-- AUTO:scoreboard -->
| ID | Dimension | vs Python | vs Field | Wave | Arc | Note |
|----|-----------|-----------|----------|------|-----|------|
| 1 | provable-correctness | won-by-design | lost-must-earn | W7 | 2 | Lumen's correctness story is scoped contracts plus capability-effects, and both are design-stage today (neither landed). Wave W7 (build-order item 4) covers ... |
| 2 | numeric-exactness-decimal | winnable-gated-open | structural-opening | W1 | 1 | Cleanest opening on the board per the doc; not landed yet. The live task tracker shows D1-D5 decimal work in progress under wave W1, ahead of either doc's ow... |
| 3 | determinism-and-replay | won-by-design | won-across-field | - | 2 | Determinism half is real and CI-gated today. Replay half (lumen run --record, deterministic tape) is Arc 2 work; ROADMAP_2036.md's gap register: 'none is imp... |
| 4 | effect-safety-and-capability-sandboxing | won-by-design | aspiration-contested | - | 2 | Design-only today: only the Console capability exists (docs/rfcs/0001-capabilities-v1.md, status draft, PR #52). Koka still leads on effect-system expressive... |
| 5 | toolchain-trust-self-hosting-fidelity | won-by-design | won-across-field | - | - | Self-hosting is table stakes across the field; Lumen's differentiator is the bit-identity fixpoint gate itself, already CI-gated every commit, not a future m... |
| 6 | compiler-as-a-reward-environment | won-by-design | won-across-field | - | 3 | Won on today's grounded ingredients (deterministic runs, stable diagnostic codes, sub-millisecond warm compile, the hermetic promptgreen rig v0). The RL-lift... |
| 7a | generated-code-speed-runtime | won-by-design | lost-must-earn | W6 | - | Lumen loses to the whole LLVM family and the JVM on real workloads today. Full Float coverage on the LLVM path is gated bit-identical (native/llvm_float_test... |
| 7b | compile-latency-sub-axis | - | structural-opening | W6 | - | Lumen-only numbers today; no cross-language comparison has been designed or run in this tree. VISION_2036.md does not separately score compile latency agains... |
| 8 | build-determinism-and-supply-chain | won-by-design | won-across-field | - | 1 | Tied with Go and Zig, not sole champion, until the air-gap test (Arc 1 exit gate) is green. The purity gate (tools/purity_gate.mjs) is an advisory reporter, ... |
| 9 | ai-authorability-intent-to-green | winnable-gated-open | lost-must-earn | W5 | 3 | Arc 3's kill criterion applies here: if reinforcement against the compiler shows no measurable authorship gain by end-2029, the plan pivots to the verified-i... |
| 10 | governance-and-evolution-velocity | won-by-design | won-across-field | - | - | Caveat: incumbents carry vast installed bases and their caution is a feature; Lumen is young and small, so speed is cheap today. The durable edge is the mech... |
| 11 | debuggability | won-by-design | split | - | 2 | Kept as one entry rather than split into 11a/11b: the doc gives this row a single verdict word ('Split') rather than two separately-graded sub-verdicts the w... |
| 12 | ecosystem-breadth-and-hiring | subsumed | lost-must-earn | W7 | 4 | Subsumption strategy, not a race to win the axis directly: lower verified cores to a host (C, LLVM, WASM, Python, Rust) so incumbent ecosystems become Lumen'... |
| 13 | human-familiarity-today | subsumed | lost-must-earn | W5 | 3 | Tied to the same corpus-and-reinforcement loop as dimension 9 (the doc says so directly). Tiny today; grown only by the corpus. |
<!-- /AUTO:scoreboard -->

## Kernel suite (auto-appended, dated snapshots)

Rendered from `bench/kernel_suite_bench.mjs`. Do not hand-edit the block between the markers below; edit the bench script and re-run instead.

<!-- AUTO:kernel-suite -->
| Date | Kernel | Lumen-native | Hand-C | Ratio (lumen/C) | clang flags |
|------|--------|--------------|--------|-----------------|-------------|
| 2026-07-15 | bs_greeks | 0.175ms | 0.057ms | 3.08x | -O2 -ffp-contract=off -fno-fast-math |
| 2026-07-15 | vol_surface_heston | 0.000ms | 0.000ms | n/a | -O2 -ffp-contract=off -fno-fast-math |
| 2026-07-15 | bond_price | 0.000ms | 0.056ms | n/a | -O2 -ffp-contract=off -fno-fast-math |
| 2026-07-15 | swap_rate | 0.210ms | 0.214ms | 0.98x | -O2 -ffp-contract=off -fno-fast-math |
| 2026-07-15 | implied_vol | 0.310ms | 0.000ms | n/a | -O2 -ffp-contract=off -fno-fast-math |
| 2026-07-15 | fib(32) | 7.286ms | 6.579ms | 1.11x | -O2 -ffp-contract=off -fno-fast-math |
<!-- /AUTO:kernel-suite -->
