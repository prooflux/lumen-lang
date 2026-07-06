# Lumen Architecture

> **This file is partly self-updating.** The prose is authored; the factual lists marked
> `<!-- AUTO:... -->` (kernels, native emitters, CI gates) are regenerated on every merge to `main`
> by `tools/architecture-update.lm` (a Lumen program) via `tools/architecture-update.mjs`. See
> [How this document stays current](#how-this-document-stays-current). Deeper design docs:
> `docs/DESIGN.md`, `VISION_2035.md`, `docs/ROADMAP_YEAR1.md`, `LANGUAGE.md`, `seed/ARCHITECTURE.md`.

## The condition

Lumen aims to be self-hosted to the metal: it compiles itself, and the goal is that every shipped
artifact is Lumen source compiled by Lumen, with the machine as the only thing underneath. Today it
is **self-hosted in source** (`lumenc.lm` compiles itself bit-identically, `SELF: MATCH`) and the
native backend is substantially built; the remaining gap is emitting its own runnable binary
(the native fixpoint). Three invariants hold on every change: **oracle-gated** (every layer is
bit-exact against a Lumen reference), **never slower** (`perf.mjs` gates throughput), and
**self-hosted** (no foreign language becomes the real artifact; host shims are disposable bootstrap).

## The layered stack

```
  web traffic          pure-Lumen HTTP protocol kernels (parse/build over raw memory)
  native backend       Lumen-written emitters (IR -> C / LLVM) + a Lumen optimizer
  self-hosting         lumenc.lm: the compiler written in Lumen, compiles itself
  the seed             seed/lumenc.wat: pure-WAT bootstrap compiler + interpreter
  the machine          a wasm engine today; native machine code is the endgame
```

## The seed (`seed/lumenc.wat`)

The bootstrap compiler and interpreter, written in pure WebAssembly text, with no dependency on any
other language. It lexes, parses, type-checks, and lowers **Lumen-mu** (the runnable subset) to a
compact stack-machine IR, and interprets that IR. Its only host seam is a single `console_print`
import; everything else is arithmetic over a flat linear memory (100 pages, ~6.5 MB).

- **IR / opcode model.** A stack machine: `PUSH`, `GETARG`, arithmetic and comparisons, `JZ`/`JMP`,
  `CALL`/`RET`, `RESERVE`/`SETLOCAL` (call frames), `PRINTINT`/`PRINTTEXT`, text ops, sum-type ops,
  floats, heap Float arrays, the raw-memory keystone `load8`/`store8`/`load32`/`store32`, and the
  bitwise builtins `band`/`bor`/`bxor`/`shl`/`shr`/`bnot` (i64, `shr` logical/unsigned) - the
  primitives the HTTP, tooling, and future crypto kernels build on.
- **Execution model.** `$run` sets `pc = main_entry` with an empty operand stack and call stack,
  then dispatches. Calls push a return frame onto the call stack (base `9216`); frame locals live at
  base `1024`; the Text heap bump-allocates in `[488000, 524288)`. A guard makes a top-level `RET`
  (main returning, no caller frame) halt instead of underflowing the call stack.
- **Determinism + safety.** No wall-clock, no randomness; a fuel cap guarantees termination on any
  input, so the compiler and interpreter are a pure, replayable function of their input.

## Self-hosting (`seed/lumenc.lm`)

The same compiler, written in Lumen. It compiles itself to the identical IR the seed produces
(`SELF: MATCH`, enforced by `seed/selfhost_diff.mjs`). This is what makes the seed disposable: the
language is defined by a compiler expressed in the language.

A language feature is **not self-hosted until it lands in `lumenc.lm`**, not just the seed: the seed
(`.wat`) and the host shims (`.mjs`) are disposable bootstrap, so a builtin added only there would
vanish when they are retired. `selfhost_diff.mjs` guards this - it compiles a corpus (including a
program that exercises the feature) with both the seed and `lumenc.lm` and requires bit-identical
output. Bitwise, for example, is dispatched in `lumenc.lm` and gated by `mu/examples/bitwise.lm`.

## The native backend (`native/`)

The path from IR to native code, written in Lumen and driven by a disposable host shim.

- `native/emit_fn.lm` - the production C emitter: per-function lowering of the IR, benchmarked at or
  above hand-written C on scalar and looped code.
- `native/emit_llvm.lm` - an LLVM-IR emitter over the same IR.
- `native/optimize.lm` - a Lumen-written optimizer (jump-threading, constant folding, dead-code
  elimination) that also optimizes the compiler itself.
- `native/pipeline.mjs` - the disposable driver: it compiles a `.lm` with the seed, snapshots the IR
  into a fresh instance's scratch region, runs the chosen Lumen emitter, and assembles the result.
  It is re-derived in Lumen at the native fixpoint.

The **native fixpoint** (the compiler compiling itself to a native binary and retiring the seed) is
in progress: the heap/IR-injection blocker is fixed and `emit_fn.lm` now emits the whole compiler;
remaining work is clang-clean codegen and the native driver. See `docs/NATIVE_BACKEND_PLAN.md`.

### Lumen-written emitters and passes

<!-- AUTO:emitters -->
- `emit`
- `emit_fn`
- `emit_llvm`
- `optimize`
<!-- /AUTO:emitters -->

## Web traffic: pure-Lumen HTTP kernels (`examples/http/`)

The HTTP protocol layer, written entirely in Lumen over raw-memory byte buffers (no compiler
feature beyond `load8`/`store8` and arithmetic, so it is perf-neutral by construction). The host
seam writes request bytes into the input buffer; a kernel reads them and emits parsed fields or
response bytes.

`http_serve.lm` closes the loop into an actual server: given a raw request and a route table (both
staged in raw memory), it parses the request line, linear-scans the table for a method+path match,
and frames the exact HTTP/1.1 response bytes. `seed/lumen_serve.mjs` is the socket seam in front of
it: a thin host shim that owns only the TCP socket (the one thing a wasm program cannot do, the same
class of capability as `console_print`) and, per connection, copies the request into the kernel's
memory, runs the kernel, and writes the response bytes back. The routing is the kernel's; the socket
is the machine's. All runtime offsets stay inside the window the interpreter and the native binary
both agree on (above the interpreter's compile pages, below the native heap cap), so the same kernel
source runs in the interpreter (the correctness oracle) and, compiled through `emit_fn.lm` to native
code, as the fast artifact. `native/http_serve_bench.mjs` measures that native artifact against an
identical scripting-language implementation of the same parse/route/build work: byte-for-byte the
same responses, and the native kernel runs the serving hot path many times faster (measured, not
asserted).

`native/lumen_serve_native.mjs` is the live fast path: it compiles the same kernel to native code and
drives it behind a keep-alive TCP socket (the emitter's one-shot `main` is replaced with a
length-framed serve loop that calls the compiled entry per request; the route table self-stages, and
body bytes stream into the binary at startup). On a fair over-the-wire test - both servers returning
the identical page as a cached blob, keep-alive on both, single worker each - the native edge serves
several times the throughput of a scripting web stack, so the win survives an honest wire benchmark
and not just the in-process one. Live TLS and HTTP/2 framing are terminated at the platform edge
today; native in-language sockets (which retire even the socket shim) and a native child pool are the
next steps.

A proxy-mode flag lets the kernel front a whole existing site while routes migrate onto it one at a
time: it serves the routes it owns and, for anything unmatched, emits an empty response so the shim
forwards the request to a configured origin. The routes Lumen owns run at native speed; the rest are
transparently proxied until they too are moved onto the kernel. Default (no origin) stays a plain 404.

<!-- AUTO:kernels -->
- `content_type_value`
- `hex_decode`
- `hex_encode`
- `http_chunked`
- `http_headers`
- `http_keepalive`
- `http_request_body`
- `http_response`
- `http_router`
- `http_serve`
- `http_status_line`
- `int_parse`
- `parse_request`
- `query_parse`
- `to_lower`
- `trim`
- `url_decode`
<!-- /AUTO:kernels -->

## Host shims (disposable bootstrap)

Written in a host language only to bootstrap; each is re-derived in Lumen at self-hosting and does
not ship as the real artifact:

- `seed/compiler_core.mjs` - a warm, reusable compile/run/ir surface over the assembled seed.
- `seed/lumen.mjs` - the CLI (`run` / `check` / `ir`).
- `seed/lumend.mjs` - the warm Unix-socket daemon (sub-millisecond compiles).
- `seed/lumen_serve.mjs` - the TCP socket seam for `http_serve.lm`: binds a port, hands each
  connection's bytes to the kernel, writes back the response the kernel built.
- `seed/lumen_mcp.mjs` - the MCP server exposing the full compiler to LLM clients (check, fix, run,
  ir, explain, tokens, types, optimize, emit_c, emit_llvm).

## The Forge (`forge/`)

A deterministic, type-directed differential fuzzer that grows the oracle corpus on its own. It
generates programs and runs them down multiple paths (interpreter, self-hosted IR, optimizer, C,
LLVM), flagging any divergence. Robustness compounds without hand-writing every case.

## Gates (CI)

Every change is held by the same gates locally and in CI, so nothing merges unproven. The oracle
gates assert bit-identity against the interpreter reference; `perf.mjs` asserts no throughput
regression; the Forge adds adversarial coverage. The full gate list run by `.github/workflows/gate.yml`:

<!-- AUTO:gates -->
- `optimize_diff.mjs`
- `native_diff.mjs`
- `rawmem_diff.mjs`
- `native_fn_test.mjs`
- `native_float_test.mjs`
- `llvm_diff.mjs`
- `standalone_diff.mjs`
- `heapcap_test.mjs`
- `fixpoint_emit_test.mjs`
- `http_parse_test.mjs`
- `http_headers_test.mjs`
- `http_response_test.mjs`
- `url_decode_test.mjs`
- `http_chunked_test.mjs`
- `http_request_body_test.mjs`
- `http_router_test.mjs`
- `query_parse_test.mjs`
- `http_status_line_test.mjs`
- `hex_encode_test.mjs`
- `hex_decode_test.mjs`
- `int_parse_test.mjs`
- `trim_test.mjs`
- `to_lower_test.mjs`
- `http_keepalive_test.mjs`
- `content_type_value_test.mjs`
- `http_serve_test.mjs`
- `lumen_serve_native.mjs`
<!-- /AUTO:gates -->

## How this document stays current

The factual lists above (kernels, emitters, gates) drift as the project grows, which is exactly
what goes stale in hand-maintained architecture docs. They are regenerated by a Lumen program:

1. `tools/architecture-update.lm` is a pure byte-in / byte-out Lumen kernel: given newline-separated
   names in its input buffer, it renders a markdown bullet list to its output buffer. All the
   rendering logic is in Lumen - dogfooding the language for the part it can do.
2. `tools/architecture-update.mjs` is the thin host seam Lumen lacks: it lists the kernels, emitters,
   and gates from the filesystem, hands each list to the Lumen renderer, and splices the result into
   the `<!-- AUTO:... -->` blocks here.
3. `.github/workflows/architecture.yml` runs it on every push to `main` and commits the refreshed
   file, so this document is current by definition after each merge. Run it by hand with
   `node tools/architecture-update.mjs`, or check for drift in CI with `--check`.
