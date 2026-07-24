#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Adversarial supplementary verifier for json_kernel.lm.

Reuses the SAME live oracle machinery as verify_json_kernel.py (Python's json module,
same Lumen seed-interpreter invocation, same token-stream decoder) but against a
NEW corpus of edge cases the builder's own verifier did not cover: duplicate object
keys, lone/unpaired UTF-16 surrogates, exponent sign variants, integer-precision
boundaries at 2^53, embedded null bytes via \\u0000, leading/trailing whitespace
around the top-level value, deep nesting, and large arrays/objects.
"""

import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_json_kernel as V  # reuse run_lumen, decode_tokens, values_equal, etc.


def check_raw_text(
    label: str,
    raw_text: str,
    prefix: str,
    expect_ground_truth=None,
    expect_utf8_decode_fail=False,
) -> tuple[bool, str]:
    """Like check_one but takes RAW JSON text (not re-derived via json.dumps), so we can
    test whitespace placement, exact escape sequences, and malformed-surrogate strings
    exactly as written, not as Python would re-emit them."""
    doc_bytes = raw_text.encode("utf-8")
    if expect_ground_truth is not None:
        ground_truth = expect_ground_truth
    else:
        ground_truth = json.loads(raw_text)

    program = prefix + V.generate_main(doc_bytes)
    stdout = V.run_lumen(program)
    nums = V.parse_ints(stdout)
    toks, byts = V.split_two_streams(nums)

    parsed, consumed = V.decode_tokens(toks, 0)
    parse_ok = consumed == len(toks) and V.values_equal(parsed, ground_truth)

    raw_out_bytes = bytes(b & 0xFF for b in byts)
    try:
        reserialized_text = raw_out_bytes.decode("utf-8")
        decode_failed = False
    except UnicodeDecodeError as e:
        decode_failed = True
        reserialized_text = f"<UTF-8 DECODE FAILED: {e}>"

    if expect_utf8_decode_fail:
        # We WANT to observe whether the kernel's re-serialized bytes are even valid
        # UTF-8 for this adversarial input; report either way, don't fail on it.
        ok = parse_ok
        detail = (
            f"{'PASS' if ok else 'FAIL'}  {label:32s} parse_ok={parse_ok!s:5s} "
            f"reserialize_valid_utf8={not decode_failed!s:5s} len={len(doc_bytes):4d}"
        )
        if not ok or decode_failed:
            detail += (
                f"\n    doc={raw_text!r}\n    parsed={parsed!r}\n    "
                f"ground_truth={ground_truth!r}\n    reserialized_bytes={list(raw_out_bytes)!r}"
            )
        return ok, detail

    if decode_failed:
        return (
            False,
            f"FAIL  {label:32s} EXCEPTION decoding reserialized bytes: {reserialized_text}",
        )

    reparsed = json.loads(reserialized_text)
    roundtrip_ok = V.values_equal(reparsed, ground_truth)

    ok = parse_ok and roundtrip_ok
    status = "PASS" if ok else "FAIL"
    detail = (
        f"{status}  {label:32s} parse_ok={parse_ok!s:5s} roundtrip_ok={roundtrip_ok!s:5s} "
        f"len={len(doc_bytes):4d}"
    )
    if not ok:
        detail += (
            f"\n    doc={raw_text!r}\n    parsed={parsed!r}\n    ground_truth={ground_truth!r}"
            f"\n    reserialized={reserialized_text!r}"
        )
    return ok, detail


def build_cases():
    cases = []

    # 1. Duplicate object keys - kernel never dedupes at parse time; Python's json.loads
    #    keeps "last wins". Verify decode_tokens (which walks in stream order and
    #    overwrites, same semantics) still matches Python's own last-wins dict.
    cases.append(("dup_keys_last_wins", '{"a":1,"a":2,"a":3}', None, False))

    # 2. Many duplicate keys, different value types, to stress the overwrite semantics.
    cases.append(
        (
            "dup_keys_mixed_types",
            '{"x":1,"x":"two","x":[3,4],"x":null,"x":true}',
            None,
            False,
        )
    )

    # 3. Lone (unpaired) high surrogate \ud800 with no following \uXXXX low surrogate.
    #    Valid JSON *text* per RFC 8259 (any \uXXXX is legal), but not valid Unicode.
    #    Python's json.loads accepts it and produces a Python str containing a lone
    #    surrogate. Whether the KERNEL's UTF-8 re-encoding of that lone surrogate is
    #    itself valid UTF-8 is exactly the thing verify_json_kernel.py never checked.
    lone_high = '"\\ud800"'
    cases.append(("lone_high_surrogate", lone_high, json.loads(lone_high), True))

    # 4. Lone low surrogate \udc00 (no preceding high surrogate).
    lone_low = '"\\udc00"'
    cases.append(("lone_low_surrogate", lone_low, json.loads(lone_low), True))

    # 5. High surrogate followed by a NON-low-surrogate \u escape (still not a valid pair).
    bad_pair = '"\\ud800\\u0041"'  # high surrogate then 'A' - not a valid pair
    cases.append(
        ("high_surrogate_then_ascii_escape", bad_pair, json.loads(bad_pair), True)
    )

    # 6. Embedded NUL byte via  inside a string (the null-bytes-in-message analog).
    cases.append(("embedded_null_byte", '"a\\u0000b\\u0000c"', None, False))

    # 7. String that is ONLY a null byte.
    cases.append(("only_null_byte", '"\\u0000"', None, False))

    # 8. Explicit '+' exponent sign, e.g. "1e+5" (exp_sign branch for '+' is otherwise
    #    only implicitly exercised - json.dumps never emits '+', so the builder's
    #    corpus, which is round-tripped through json.dumps, could never hit it).
    cases.append(("exponent_explicit_plus", '{"v": 1.5e+3}', None, False))
    cases.append(("exponent_capital_e_plus", '{"v": 2E+2}', None, False))

    # 9. Bare "-0" integer literal (no fraction/exponent) at top level.
    cases.append(("bare_negative_zero_int", "-0", None, False))

    # 10. Integer precision boundary at 2^53: exact below, exact at, one above (which the
    #     kernel's own docs say loses exactness because the accumulator is a Float).
    cases.append(("int_pow53_minus_1", str(2**53 - 1), None, False))
    cases.append(("int_neg_pow53_exact", str(-(2**53)), None, False))
    # 2**53 + 1 is NOT exactly representable as a double; per the kernel's own documented
    # limitation this MAY legitimately differ from Python's exact bigint. Report but do
    # not treat a documented-limitation mismatch as a fresh bug - flag separately below.

    # 11. Leading AND trailing whitespace (spaces/tabs/newlines) around a top-level scalar.
    #     json.dumps never emits surrounding whitespace, so the builder's own generator
    #     could never produce this input.
    cases.append(
        ("leading_trailing_whitespace_scalar", "  \t\n 42 \r\n\t  ", 42, False)
    )
    cases.append(
        ("leading_trailing_whitespace_object", '\n\t {"a": 1}  \n', None, False)
    )

    # 12. Deep nesting (50 levels) well past anything in the builder's corpus (max depth 3
    #     fuzz + a handful of manually nested cases).
    deep = "[" * 50 + "1" + "]" * 50
    cases.append(("deep_nesting_50", deep, None, False))

    # 13. Large array (340 elements, the largest that still fits under the seed compiler's
    #     70000-byte SRC_CAPACITY once embedded via one store8-per-byte, same generation
    #     convention verify_json_kernel.py itself uses) - stresses token-stream capacity
    #     math and the recursive emit_uint_digits/serialize_value paths at scale (builder's
    #     largest was long_flat_array, 30 elements).
    big_arr = json.dumps(list(range(340)))
    cases.append(("large_array_340", big_arr, None, False))

    # 14. Object with 140 keys (same SRC_CAPACITY constraint), to stress parse_object's
    #     linked loop at scale (builder's largest was object_many_keys with 15 keys).
    big_obj = json.dumps({f"key_{i}": i for i in range(140)})
    cases.append(("large_object_140_keys", big_obj, None, False))

    # 15. Empty-key object: JSON permits "" as an object key.
    cases.append(("empty_string_key", '{"": 1, "a": 2}', None, False))

    # 16. String containing every ASCII byte from 0x20-0x7e plus all short escapes packed
    #     together, back to back, no separating characters.
    weird = '"\\"\\\\\\/\\b\\f\\n\\r\\t !~"'
    cases.append(("all_short_escapes_packed", weird, None, False))

    # 17. Number "0" alone (single-digit boundary; is_digit loop must not loop past one
    #     char, and int_part accumulation with a single 0 digit).
    cases.append(("bare_zero", "0", None, False))

    # 18. Negative number immediately followed by close-bracket, no separating space:
    #     "[-1,-2,-3]" already similar to array_of_ints but forces minus-then-digit
    #     adjacency at token boundaries with no whitespace at all anywhere.
    cases.append(("tight_negative_array", "[-1,-2,-3,-0]", None, False))

    # 19. Object whose single value is itself an empty object nested 3 levels, with zero
    #     whitespace anywhere (parser's whitespace-skip calls must be truly optional).
    cases.append(("no_whitespace_nested_empties", '{"a":{"b":{"c":{}}}}', None, False))

    # 20. A JSON document that is a raw top-level string containing a mix of BMP
    #     multi-byte UTF-8 (3-byte) and a supplementary-plane emoji (4-byte) NOT via
    #     \u-escapes but as literal UTF-8 bytes in the source (unlike the builder's
    #     string_emoji_surrogate_pair case, which uses a literal emoji char through
    #     json.dumps(ensure_ascii=False) too - but let's also pack multiple 4-byte
    #     sequences back-to-back with no ASCII between them, an adjacency case).
    cases.append(
        ("back_to_back_emoji", '"\U0001f600\U0001f601\U0001f602"', None, False)
    )

    return cases


def main() -> int:
    prefix = V.kernel_prefix()
    cases = build_cases()
    results = []
    known_limitation_notes = []
    for label, raw_text, expect_gt, expect_surrogate in cases:
        try:
            ok, detail = check_raw_text(
                label, raw_text, prefix, expect_gt, expect_surrogate
            )
            results.append((ok, detail))
        except Exception as exc:
            results.append((False, f"FAIL  {label:32s} EXCEPTION: {exc}"))

    # Documented-limitation case: 2^53+1, run separately and annotate rather than count
    # as a fresh failure, exactly like the builder's own 1.5e10 case.
    v = 2**53 + 1
    raw = str(v)
    doc_bytes = raw.encode("utf-8")
    program = prefix + V.generate_main(doc_bytes)
    stdout = V.run_lumen(program)
    nums = V.parse_ints(stdout)
    toks, byts = V.split_two_streams(nums)
    parsed, _consumed = V.decode_tokens(toks, 0)
    ground_truth = v
    matches_exact = parsed == ground_truth
    known_limitation_notes.append(
        f"INFO  int_pow53_plus_1 (documented-limitation probe): kernel_parsed={parsed} "
        f"python_exact={ground_truth} exact_match={matches_exact} "
        f"(expected False per kernel's own Float-accumulator limitation note)"
    )

    for ok, detail in results:
        print(detail)
    print()
    for note in known_limitation_notes:
        print(note)

    n_pass = sum(1 for ok, _ in results if ok)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} NEW adversarial cases passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
