import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

EXPECTED = "210345902\n"


def run_reference():
    result = subprocess.run([sys.executable, REF], capture_output=True, text=True)
    assert result.returncode == 0, f"reference.py exited nonzero: {result.stderr}"
    return result.stdout


def main():
    out = run_reference()
    lines = out.split("\n")
    assert len(lines) == 2 and lines[1] == "", f"expected exactly one line, got {out!r}"
    assert out == EXPECTED, f"fib(90) mod 1000000007 expected {EXPECTED!r}, got {out!r}"
    assert lines[0].isdigit(), f"expected a plain nonnegative integer, got {lines[0]!r}"
    print("t28 hidden tests: PASS")


if __name__ == "__main__":
    main()
