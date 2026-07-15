# Provenance and extraction audit

- This repository carries the complete development history of Lumen, extracted from its
  private development monorepo with
  `git filter-repo --path projects/lumen/ --path-rename projects/lumen/:` on a fresh clone.
  Only commits touching the Lumen tree are present; authorship and dates are preserved.
- Re-extracted 2026-07-03 when Lumen graduated to this repository as its standalone home
  (superseding the 2026-07-02 initial publication, which was missing five later commits
  including the self-hosting fixpoint). History is authoritative here from this point on.
- Safety audit before publication:
  - gitleaks over all history: 159 commits scanned, no leaks found.
  - Full-history secret-pattern grep (tokens, key blocks, api keys): no hits.
  - File census of every path that ever existed: reviewed; no non-Lumen content.
  - Tip hygiene: two internal session logs moved to docs/history-notes/, absolute
    local paths rewritten to repo-relative.
- Deliberately KEPT in history: the fake self-host commits and the reward-hacked
  benchmark era, with the commits that caught and removed them. The oracle-gated
  process is the product; its failure ledger is evidence, not embarrassment.
- The WebAssembly bootstrap seed (`seed/lumenc.wat`; `seed/seed.wat` was its pre-rename
  ancestor, already absent from the tree before R5) was retired as the *live oracle* in the
  R5 wasm-retirement campaign: a checked-in, reproducible C bootstrap trio
  (`native/lumenc.bootstrap.c`, `emit_fn.bootstrap.c`, `optimize.bootstrap.c`) plus a pure-JS
  in-process interpreter (`native/ir_interpreter.mjs`) took over as the from-scratch genesis
  and correctness-gate reference. Its historical state as the load-bearing oracle is pinned
  forever at the `wat-genesis` tag. `seed/lumenc.wat` itself is NOT yet removed from the
  working tree: two narrowly-scoped exceptions (`native/fuel_build.mjs`,
  `native/pipeline.mjs`'s `emit_llvm.lm` path, both documented in ARCHITECTURE.md) still
  parse it directly at runtime, and both back currently-required CI gates
  (`llvm_diff.mjs`, `llvm_float_test.mjs`). It becomes deletable once `emit_llvm.lm` gets its
  own bootstrap-C translation.
