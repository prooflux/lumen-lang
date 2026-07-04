# Lumen

[![gate](https://github.com/prooflux/lumen-lang/actions/workflows/gate.yml/badge.svg)](https://github.com/prooflux/lumen-lang/actions/workflows/gate.yml)


An AI-native programming language: authored by LLM agents, gated by executable oracles.

The compiler proves itself correct on every commit: the self-hosted compiler (written in
Lumen) reproduces the reference seed's compilation of its own source bit-for-bit, and the
native backends (C emitter, LLVM emitter - both written in Lumen) are CI-gated to
byte-identical output against the reference interpreter on a fixed conformance corpus.

This repository is the project's home: the full toolchain (the WAT reference seed, the
self-hosting `lumenc.lm`, the C and LLVM native emitters, the IR optimizer, the warm daemon
and MCP authoring tools) and the conformance corpus live here. Its history is the complete,
audited development record extracted from the private development monorepo where the language
was bootstrapped; see [docs/PROVENANCE.md](docs/PROVENANCE.md) for the extraction and safety
audit. The methodology paper ("Oracle-Gated Self-Hosting: Building a Programming Language with
LLM Agent Fleets") is in preparation.

## Quick start

```sh
cd seed && npm install                 # one-time: the wabt assembler
node lumen.mjs run ../mu/examples/fib_print.lm   # prints 55
npm test                               # conformance + safety + loop + cache gates
```

The runnable conformance programs live in `mu/examples/`. (The top-level `examples/`
directory holds forward-looking programs that exercise not-yet-landed syntax.)

## Official file extension

Lumen source files use the **`.lm`** extension (e.g. `lumenc.lm`, the self-hosted compiler).
`.lm` is unclaimed in GitHub Linguist and is used consistently across the toolchain, the
conformance corpus, and the MCP authoring tools. (`.el` was evaluated and rejected: it is
owned by Emacs Lisp in every syntax-highlighting and language-detection registry.)
A GitHub Linguist registration PR becomes eligible once `.lm` usage exists across enough
public repositories; until then, per-repo highlighting can use a `.gitattributes` override.
