import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

EXPECTED = "88963"


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    ).stdout

    lines = out.strip().split("\n")
    assert len(lines) == 1, f"expected exactly one output line, got {lines!r}"

    assert lines[0] == EXPECTED, f"expected {EXPECTED!r}, got {lines[0]!r}"

    n = int(lines[0])
    assert 0 < n < 100000000, f"IRR out of sane range: {n}"

    print("t29 hidden tests: OK")


if __name__ == "__main__":
    main()
