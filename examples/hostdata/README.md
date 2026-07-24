# Host-fed decision kernels (the codegen seam)

The pattern for putting a Lumen kernel in charge of live decisions while the
transport (network, TLS, signing) still lives on a host shim:

```
host fetch (live data)  ->  generate main() with data embedded
                        ->  kernel.lm + generated main  ->  lumen run
                        ->  token-walk parse emitted records
                        ->  host RE-COMPUTES and HALTS on any diff
```

- **The kernel is the authority; the host is the courier.** The host acts on
  the kernel's output, never on its own computation. Its only computational
  role is the cross-check: recompute every decision independently and refuse
  to proceed on any disagreement, so every live iteration is a
  two-implementation proof rather than trust.
- **The codegen seam:** programs cannot read stdin or files yet, so live data
  reaches the kernel as literal arguments in a generated `main()` appended to
  the kernel fragment. Deterministic, auditable (the generated program IS the
  input record), and cheap under the warm daemon; the cost is a recompile per
  data refresh. A stdin/file data path is tracked friction that would retire
  this seam without changing any kernel.
- **Parsing:** CLI stdout concatenates `console.print` output without
  newlines, so consumers split on record keywords and walk fixed arities
  (see `decide_kernel.lm`'s `DEC` records). Also tracked friction.
- **Toward full ownership:** the staged plan for moving transport itself into
  Lumen (JSON, SHA-256, HMAC, bignum + RSA-PSS signing, a hosted-TLS interim
  seam, TLS 1.3 with kill criteria) is
  `docs/plans/2026-07-22-signed-https-client.md`.

`decide_kernel.lm` is the runnable, self-contained demonstration: a generic
scoring/gate kernel with a demo main standing in for the host's generated one.

## Signed API request demo (RSA-PSS, pure Lumen)

`signed_api_request_demo.lm` composes the four from-scratch kernels proved in this
session - SHA-256 (`sha256_kernel.lm`), bignum (`bignum_kernel.lm`), HMAC-SHA256
(`hmac_kernel.lm`), and RSA-PSS signing (`rsa_pss_kernel.lm`) - into one end-to-end
demonstration: **Lumen computing a real, verifiable RSA-PSS request signature natively**,
with zero host-side crypto calls anywhere in the file.

The scenario is deliberately generic (no real vendor, account, or API is named): many REST
APIs that sign requests with an asymmetric key use the pattern
`message = <unix_timestamp> || <HTTP_METHOD> || <request_path>`. The demo builds that exact
message (`"1735689600POST/v1/orders"`), signs it with RSA-PSS-SHA256 (MGF1(SHA-256), salt
length 32, a fixed 32-byte test salt) under a throwaway 768-bit RSA key generated once for
this file (safe to publish - it backs nothing else), and prints the 96-byte signature as hex.

Run it:

```
node ../../seed/lumen.mjs run signed_api_request_demo.lm
```

(from `examples/hostdata/`; or `node seed/lumen.mjs run examples/hostdata/signed_api_request_demo.lm`
from the repo root.)

Verification is real, not simulated: the printed signature was independently checked with
Python's `cryptography` library, the same way `rsa_pss_verify.py` checks every kernel test
case - `RSAPublicKey.verify()` configured with `PSS(MGF1(SHA-256), salt_length=32)` and
SHA-256, against the public key `(n, e=65537)` reconstructed from the literal `n`/`e` values
documented in the demo file's header comment. It returned no `InvalidSignature` exception.

**Out of scope** (still host concerns, tracked in
`docs/plans/2026-07-22-signed-https-client.md`): TLS transport, PEM/DER key parsing, and the
socket itself. This demo takes the RSA key already decomposed into little-endian 32-bit limb
arrays (the same representation `rsa_pss_kernel.lm` uses everywhere) and prints a hex
signature to stdout - it does not open a connection, send an HTTP request, or parse a key
file. Those remain host-shim responsibilities per the staged plan referenced in
`decide_kernel.lm`'s section above.

## Known issues (adversarial re-verification, 2026-07-23 - landed with the kernels rather
than held back, per explicit instruction, so they are visible; NOT yet patched)

An adversarial pass ran additional test cases against each kernel's own live oracle (Python's
`json`/`hmac`/`hashlib`/`cryptography`, and native arbitrary-precision ints) beyond what each
builder's own verifier covered. Two of five kernels came back CONTESTED, and both trace to
the SAME underlying language-level defects rather than being independent kernel bugs:

1. **Silent array/Text heap ceiling (severe).** `json_kernel.lm` and `hmac_kernel.lm` both
   hit an undocumented, shared, never-freed ~36288-byte heap ceiling across all arrays in a
   running program. Crossing it does not error - the seed interpreter **exits 0 with zero
   output**, indistinguishable from a legitimate empty result. Reproduced with a bare 2-line
   `iarray()` probe outside any kernel logic, so this is a **Lumen runtime limitation**, not
   a JSON or HMAC bug. Concretely: a 150-element JSON array, or an HMAC call with a 32/64-byte
   key and a message past ~886 bytes, both trigger it today.
2. **`round()` half-up tie bug near 2^53.** `json_kernel.lm`'s Int parsing is documented as
   exact up to 2^53, but `2^53 - 1` round-trips to `2^53`. Traced to `seed/lumenc.wat`'s
   `FROUND` opcode (`floor(x + 0.5)`, the classic round-half-up implementation, which
   mis-rounds an exact `.5` tie at that magnitude). Reproducible with a bare `round()` probe -
   a systemic builtin defect, not JSON-specific.
3. **Two narrower JSON spec gaps:** a lone/unpaired UTF-16 surrogate escape (legal per RFC
   8259) is emitted as invalid UTF-8; a high surrogate followed by a non-low-surrogate escape
   is silently merged into the wrong codepoint instead of being kept as two characters.
4. **`rsa_pss_kernel.lm` is proven on one real signature** (the demo above, independently
   verified valid), **not yet across a broader vector suite** - a planned 10-message +
   reproducibility batch did not finish inside the build session's time budget (RSA modpow at
   768 bits costs several billion interpreter steps per signature).

`sha256_kernel.lm` and `bignum_kernel.lm` had no adversarial findings (141 and 259 total test
cases respectively, all passing against their live oracles).

**Do not treat any kernel in this directory as production-grade until #1 and #2 are fixed at
the language level** (both are natural next entries for the friction list in
`.claude/skills/lumen/SKILL.md`'s companion QUANTS session) and `rsa_pss_kernel.lm`'s broader
vector suite completes.
