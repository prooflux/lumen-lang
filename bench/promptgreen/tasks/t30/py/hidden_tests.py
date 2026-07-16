import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

EXPECTED = ["53000", "60100"]


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    ).stdout

    lines = out.strip().split("\n")
    assert len(lines) == 2, f"expected exactly two output lines, got {lines!r}"

    assert lines == EXPECTED, f"expected {EXPECTED!r}, got {lines!r}"

    mean_scaled = int(lines[0])
    assert 20000 <= mean_scaled <= 100000, f"mean out of data range: {mean_scaled}"

    variance_scaled = int(lines[1])
    assert variance_scaled >= 0, f"variance must be nonnegative: {variance_scaled}"

    print("t30 hidden tests: OK")


if __name__ == "__main__":
    main()
