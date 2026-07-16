import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = "1000.0\n0.0\n0.0\n1000.0\n"


def main():
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, "reference.py")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"nonzero exit: {result.returncode}, stderr={result.stderr}"
    )
    assert result.stdout == EXPECTED, f"expected {EXPECTED!r}, got {result.stdout!r}"

    lines = [l for l in result.stdout.split("\n") if l]
    assert len(lines) == 4, f"expected 4 lines, got {len(lines)}"
    assert lines[1] == "0.0", f"bracket-2-at-boundary edge mismatch: {lines[1]!r}"
    assert lines[3] == lines[0], (
        f"total should equal bracket-1 tax: {lines[3]!r} vs {lines[0]!r}"
    )

    print("ok")


if __name__ == "__main__":
    main()
