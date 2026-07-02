# Lumen

An AI-native programming language: authored by LLM agents, gated by executable oracles.

The compiler proves itself correct on every commit: the self-hosted compiler (written in
Lumen) reproduces the reference seed's compilation of its own source bit-for-bit, and the
native backends (C emitter, LLVM emitter - both written in Lumen) are CI-gated to
byte-identical output against the reference interpreter on a fixed conformance corpus.

This repository reserves the project's public home. The toolchain, conformance corpus,
oracle gates, and the methodology paper ("Oracle-Gated Self-Hosting: Building a Programming
Language with LLM Agent Fleets") are being prepared for extraction from the development
monorepo.

## Official file extension

Lumen source files use the **`.lm`** extension (e.g. `lumenc.lm`, the self-hosted compiler).
`.lm` is unclaimed in GitHub Linguist and is used consistently across the toolchain, the
conformance corpus, and the MCP authoring tools. (`.el` was evaluated and rejected: it is
owned by Emacs Lisp in every syntax-highlighting and language-detection registry.)
A GitHub Linguist registration PR becomes eligible once `.lm` usage exists across enough
public repositories; until then, per-repo highlighting can use a `.gitattributes` override.
