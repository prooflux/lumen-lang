# One-Year Roadmap: Lumen, self-hosted to the metal

> The plan of record for the year. Every quarter has a concrete exit criterion so progress is
> verifiable rather than vibes. The living, per-commit narrative is `../SELFHOST_CAMPAIGN_LOG.md`;
> the exact runnable language is `../LANGUAGE.md`.

## The condition

Lumen and only Lumen. It compiles itself, writes its own runnable binary, runs on the bare machine,
and serves the internet, with nothing beneath it, beside it, or above it that Lumen did not write and
prove itself. Every layer that ships is Lumen. The one external surface is the machine itself, which
Lumen reaches directly.

## North star

Lumen owns its entire existence: it turns its own source into machine code with its own code
generator, writes its own executable, runs directly on the machine with its own runtime and memory,
opens its own connections, speaks its own HTTP, secures its own traffic, and hosts and runs Lumen
programs on demand. The most robust possible language is the one that depends on nothing it did not
build and prove. That is the bet.

## Three invariants, held every day

1. **Self-hosted to the metal.** Every shipped artifact is Lumen source compiled by Lumen. A
   **purity gate** in CI fails the build the instant anything that is not Lumen tries to enter it.
   The bootstrap host is disposable, re-derived in Lumen, and retired at the native fixpoint.
2. **Oracle-gated.** Every layer is bit-exact against a Lumen reference. Proven, not hoped.
3. **Never slower.** The performance gate holds on every change. Robustness is added as Lumen
   libraries and Lumen proofs, never as compiler weight.

Where this stands today: Lumen already compiles itself in source (`SELF: MATCH`) and its native path
is nearly complete. The one place it still reaches outside itself is the final step of turning its
output into a runnable binary. Removing that is the first thing the year does.

## The full self-hosted stack (all Lumen)

```
  the application host   host + run Lumen programs on demand, sandboxed
  secure transport       encrypted connections, Lumen crypto
  HTTP                   /1.1 + /2, framing, header compression
  networking             sockets and byte movement
  concurrency            the scheduler / event loop
  core library           strings, buffers, arrays, maps
  memory                 allocation and reclamation
  the compiler           source -> machine code, self-built
  the machine            Lumen runs here, directly
```

## Q1 (months 1-3): Lumen builds Lumen

Lumen turns itself into a native binary with its own toolchain and runs with nothing beneath it.
1. Native code generator, in Lumen: its own IR to machine instructions, with register allocation.
2. Executable writer, in Lumen: lays out a runnable binary byte for byte.
3. Machine interface: Lumen-generated code reaches the machine's own entry points directly.
4. The self-hosted native fixpoint: Lumen compiles itself to a binary that is the compiler; the
   bootstrap retires. Bit-identical to the reference oracle.

**Exit:** `lumen` is a native binary that Lumen built, and it compiles Lumen to native binaries with
no toolchain but itself. Self-compilation is bit-exact and performance-gated. The purity gate is green.

## Q2 (months 4-6): The self-hosted core and runtime

Everything a real program needs, in Lumen, over raw memory.
1. Memory: a Lumen allocator with reclamation, so long-running programs stay flat.
2. Core library: full strings and byte handling, dynamic arrays, and maps, all Lumen, all gated.
3. Concurrency runtime: a Lumen scheduler and event loop so one process drives many tasks at once.
4. Robustness: the Forge fuzzes the core; memory holds flat under sustained work.

**Exit:** substantial Lumen programs run natively and concurrently with stable memory, entirely in Lumen.

## Q3 (months 7-9): Lumen serves the internet

A fully self-hosted Lumen server answering real traffic and hosting Lumen code.
1. Networking: Lumen opens and drives sockets through the machine interface, all Lumen.
2. HTTP complete: request (headers, body, chunked, keep-alive) + response builder + router + HTTP/2
   framing and header compression, pure-Lumen byte kernels (extending the request parser already landed).
3. The application host: a Lumen server that loads and runs Lumen handlers on demand, capability-
   sandboxed. Anything you want to run, you write in Lumen, and Lumen runs it.
4. Robustness: the Forge fuzzes the whole HTTP stack; a conformance suite; stable under load.

**Exit:** a single Lumen-built binary serves real concurrent HTTP/1.1+2 traffic and hosts sandboxed
Lumen handlers, benchmarked and adversarially fuzzed, Lumen from the machine up.

## Q4 (months 10-12): Secure transport, hardening, and the platform

Encrypted, robust, complete, and public.
1. Cryptographic primitives in Lumen, verified against known test vectors: the symmetric ciphers with
   authentication, the hashes, the key agreement, the signatures.
2. Secure transport in Lumen: the encrypted handshake and record layer over those primitives.
3. The platform: a module and package system and a standard library, all Lumen.
4. Robustness and launch: whole-stack fuzzing and conformance, the methodology writeup, a live public
   endpoint served end to end by one self-built Lumen binary. Tag the release.

**Exit:** a public, encrypted endpoint served entirely by a single Lumen binary, hosting sandboxed
Lumen code, crypto and transport bit-exact against test vectors, the whole stack fuzzed, and the
purity gate green from the machine to the socket.

## The honest caveat

The Q4 crypto and secure transport is the hardest single deliverable, because "nothing borrowed" means
the encryption is written and proven in Lumen too. If the verified crypto runs long, the honest outcome
is that the encrypted layer lands at the start of the next year while everything below it is fully done
and fully Lumen: a self-built native compiler, a real runtime, and a concurrent HTTP server hosting
sandboxed Lumen code. Even that floor is a complete, self-hosted platform that owes nothing to anyone.

## How it ships

Many small changes to trunk, each held by four gates at once: the oracle gate for bit-exactness, the
performance gate for speed, the Forge for adversarial coverage, and the purity gate for the condition
itself. Nothing merges unproven, and nothing merges that reaches outside Lumen. The Forge grows the
test corpus on its own, so robustness compounds without hand-writing every case.
