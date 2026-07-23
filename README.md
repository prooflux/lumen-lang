# Lumen

[![gate](https://github.com/lumen-source/lumen/actions/workflows/gate.yml/badge.svg)](https://github.com/lumen-source/lumen/actions/workflows/gate.yml)


An AI-native programming language: authored by LLM agents, gated by executable oracles.

The compiler proves itself correct on every commit: the self-hosted compiler (written in
Lumen) reproduces the reference seed's compilation of its own source bit-for-bit, and the
native backends (C emitter, LLVM emitter - both written in Lumen) are CI-gated to
byte-identical output against the reference interpreter on a fixed conformance corpus.

This repository is the project's home: the full toolchain (the bootstrap-C genesis + in-process
interpreter that replaced the WAT reference seed as the live oracle in R5, the self-hosting
`lumenc.lm`, the C and LLVM native emitters, the IR optimizer, the warm daemons (interpreted and
native) and MCP authoring tools) and the conformance corpus live here. Its history is the complete,
audited development record extracted from the private development monorepo where the language
was bootstrapped; see [docs/PROVENANCE.md](docs/PROVENANCE.md) for the extraction and safety
audit. The methodology paper ("Oracle-Gated Self-Hosting: Building a Programming Language with
LLM Agent Fleets") is in preparation.

## Quick start

```sh
cd seed && npm install                 # one-time: host shim deps (no wabt/WebAssembly - retired R5)
node lumen.mjs run ../mu/examples/fib_print.lm   # prints 55
npm test                               # conformance + safety + loop + cache gates
```

The runnable conformance programs live in `mu/examples/`. (The top-level `examples/`
directory holds forward-looking programs that exercise not-yet-landed syntax.)

Before opening a PR, run the full gate suite with `node tools/gate_all.mjs` (the exact sequence
`.github/workflows/gate.yml` runs, not a hand-remembered subset - see [`AGENTS.md`](AGENTS.md) for
why that distinction matters). Branch protection on `main` requires the `gate` check to pass before
any update lands; `node tools/land_pr.mjs <pr-number>` runs the full fetch/merge/gate/push protocol
in one command. If you are an AI agent working this repo, read [`AGENTS.md`](AGENTS.md) first.

## The document map

- [`VISION_2035.md`](VISION_2035.md): the ten-year destination and the bets.
- [`VISION_2036.md`](VISION_2036.md) and [`LANGUAGE_COMPARISON.md`](LANGUAGE_COMPARISON.md): the scored competitive case, against the incumbent and then against the field.
- [`docs/ROADMAP_2036.md`](docs/ROADMAP_2036.md): the plan of record.
- [`RULES.md`](RULES.md): the operating laws and the canonical metric names.
- [`bench/scoreboard.json`](bench/scoreboard.json) and [`bench/DASHBOARD.md`](bench/DASHBOARD.md): the live verdicts and numbers.
- [`bench/vs-c/SCOREBOARD.md`](bench/vs-c/SCOREBOARD.md): matched-kernel timings against real C (`-O3`), gated on byte-identical output first.
- [`tools/absorb/README.md`](tools/absorb/README.md): the oracle-gated contract for absorbing foreign (Python, C, C++) functions with a live, executed, sha-pinned oracle.
- [`docs/SIMD_AUTOVECTORIZATION_PLAN.md`](docs/SIMD_AUTOVECTORIZATION_PLAN.md): what Lumen gets for free from clang/LLVM's own auto-vectorizer today, and the staged plan for closing the rest of the gap.
- [`SELFHOST_CAMPAIGN_LOG.md`](SELFHOST_CAMPAIGN_LOG.md) and [`docs/VELOCITY_LEDGER.md`](docs/VELOCITY_LEDGER.md): the receipts.
- [`LANGUAGE.md`](LANGUAGE.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md): the language and the repo, as they are today.

## Official file extension

Lumen source files use the **`.lm`** extension (e.g. `lumenc.lm`, the self-hosted compiler).
`.lm` is unclaimed in GitHub Linguist and is used consistently across the toolchain, the
conformance corpus, and the MCP authoring tools. (`.el` was evaluated and rejected: it is
owned by Emacs Lisp in every syntax-highlighting and language-detection registry.)
A GitHub Linguist registration PR becomes eligible once `.lm` usage exists across enough
public repositories; until then, per-repo highlighting can use a `.gitattributes` override.
