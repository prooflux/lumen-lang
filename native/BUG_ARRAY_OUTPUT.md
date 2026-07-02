# Finding: byte-exact heap-halt parity on large arrays (NO native bug; earlier filing retracted)

## What was filed, and what is true
PR #192's HISTORY entry filed this as "the batch/array kernel loses its output natively above
~32-48KB of arrays (oracle prints, native prints NOTHING)". That claim was WRONG: the oracle side
had only been run at small n and extrapolated. Running BOTH sides at the same n shows byte-exact
parity everywhere, including the halt:

- n=2267 (2 arrays, 2*(4+8*2267)=36280 bytes): oracle "2369242\n" == native "2369242\n".
- n=2268 (36296 bytes): oracle "" == native "" (both silently halt, exit 0).

## Mechanism (verified, checkpoint (a) diagnosis)
The emitted runtime's `lm_anew` guard (`LM_CAP_BYTES` 36288, emit_fn.lm) halts silently exactly
where the interpreter's `ANEW` heap guard (`lumenc.wat` op 49) halts - this is #201's "byte-exact
heap halt parity" working as designed. An A/B patch raising the native cap makes the native binary
print where the oracle halts, i.e. the "fix" would BREAK the bit-identity contract (Rule 5).
The two `heap_boundary_*` cases in native_float_test.mjs pin this parity permanently.

## Real consequences (the actionable part)
1. **Capacity, not correctness:** ~36KB of array heap is far too small for real pricing workloads.
   Raising it is a LANGUAGE decision (grow the interpreter heap region and the emitted cap
   together, keeping parity; the #201 walls-down direction). Roadmap item, not a bugfix.
2. **The silent halt is by design** (fuel-cap precedent) but allocation failure that prints
   nothing and exits 0 is hostile for numeric work; a diagnosable halt (exit code or stderr note,
   identically on both sides) deserves a design discussion.
3. **native_batch_bench.mjs has never been oracle-conformant:** it patches the native arena
   (today 1<<24) far beyond the bound the interpreter enforces, so its historical rates measure a
   configuration the oracle cannot run. bs_batch_fn stays out of the gated bench suite until the
   language's own heap can hold the workload.
