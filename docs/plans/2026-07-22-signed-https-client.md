# Signed HTTPS client: TLS 1.3 + RSA-PSS as Lumen capabilities

Status: PLANNED (staged). Owner: the dogfood loop.
Motivation: Lumen programs can already SERVE HTTP natively (http_serve.lm, the
native socket server). The mirror-image capability is missing: acting as a
CLIENT of an authenticated REST API (exchanges, cloud services), which today
requires a host shim for two things only: TLS transport and request signing
(RSA-PSS). Closing those two gaps makes "a Lumen program that talks to a
signed API end to end" real, and both are textbook, RFC-specified kernels -
exactly the provable-core work Lumen is for.

Discipline for every stage: frozen-vector verification (NIST/RFC test vectors
plus absorb-gate runs against a reference implementation), interpreter ==
native byte-parity, perf.mjs non-regression, one stage per PR with
failing-test-first evidence. No stage ships a crypto claim without vectors.

## Stage S0 - JSON kernel (enabler, independent)
A pure-Text JSON parser/serializer (objects, arrays, strings, numbers, bool,
null) sufficient for REST payloads. No language gaps expected (Text + arrays
+ records cover it). Verification: round-trip + a frozen corpus diffed
against a reference parser. Effort: small. Also generally useful.

## Stage S1 - SHA-256
The workhorse hash. The seed already has the needed bitwise builtins
(band/bor/bxor/shl/shr/bnot on i64) and byte-level raw memory. Verification:
NIST FIPS 180-4 vectors + absorb-gate vs hashlib.sha256 over random inputs.
Effort: small-medium. Unlocks S2/S3/S5.

## Stage S2 - HMAC-SHA256
RFC 2104 over S1. Trivial once S1 lands; needed for HKDF (S5) and for
HMAC-authenticated APIs generally. Verification: RFC 4231 vectors.

## Stage S3 - bignum + RSA-PSS signing (the API-auth piece)
- Bignum: multi-limb integers on i64 arrays (add/sub/mul/mod, modpow via
  square-and-multiply, later Montgomery if perf demands - Law P measured).
- RSA sign primitive (RSASP1) + MGF1 + EMSA-PSS-ENCODE (RFC 8017, salt =
  digest length) = RSA-PSS-SIGN with SHA-256.
- Key material is an INPUT (PEM/DER parsing can start host-side; ASN.1/DER
  integer extraction in Lumen is a small follow-up). Private keys never live
  in this repo - test vectors use throwaway keys.
Verification: RFC 8017 / project-generated frozen vectors cross-checked
against a reference crypto library at freeze time (absorb pattern: the
reference runs once at absorption, the fixture gates forever). PSS is
randomized (salt), so vectors fix the salt via a deterministic test hook.
Effort: medium. This stage alone moves the security-critical signing step of
any RSA-signed API into provable Lumen, even while transport stays hosted.

## Stage S4 - interim architecture: hosted TLS seam, Lumen owns everything else
Until S5, the transport is a deliberately thin host seam (a socket-to-TLS
tunnel, same disposable-shim doctrine as the file-I/O seam). Lumen owns:
request building, header canonicalization, timestamping, S3 signing, S0
response parsing, retry/backoff logic. The seam's contract is dumb bytes in
/ bytes out, so deleting it later requires no kernel changes.

## Stage S5 - TLS 1.3 client (the long pole)
Minimum viable profile (RFC 8446): X25519 key exchange, ChaCha20-Poly1305
AEAD (bitwise-friendly, avoids AES tables), HKDF (S2), the client handshake
state machine, X.509/DER certificate parsing with chain validation against a
pinned root set. Explicitly OUT of scope for v1: TLS 1.2, session resumption,
client certificates, AES, RSA key exchange, OCSP. Verification: RFC 8448
handshake trace vectors, then live interop against real servers via the S4
seam flipped to pass-through comparison (same bytes, both paths).
KILL CRITERIA (honesty gate): if after S1-S3 the measured authoring cost of
X25519 + AEAD + X.509 projects past the value (the S4 seam is ~50 lines of
host shim and works), S5 is deliberately parked and the seam stays - a
documented boundary, not a failure. Rolling your own TLS is only worth it
here because the interpreter==native parity gate and frozen vectors give a
verification story most hand-rolled TLS lacks; without that story holding at
every step, stop.

## Stage S6 - native socket CLIENT
The native server socket kernel exists (the 34 KB socket server); the client
side needs connect() plumbing in the native runtime and a matching host-seam
fallback for the interpreter. Small, independent of crypto; can land any
time before S5 wires into it.

## Order and gating
S0, S1 land first (independent, small). S2 after S1. S3 after S1 (bignum in
parallel with S2). S4 is architecture, not code volume - it lands with the
first real consumer. S6 opportunistic. S5 last, behind its kill criteria.
Every stage: failing test first, vectors frozen, interpreter==native,
perf.mjs green, one PR each.
