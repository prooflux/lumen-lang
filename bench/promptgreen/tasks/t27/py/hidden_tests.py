import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def run_reference():
    result = subprocess.run([sys.executable, REF], capture_output=True, text=True)
    assert result.returncode == 0, f"reference.py exited nonzero: {result.stderr}"
    return result.stdout


def main():
    out = run_reference()
    lines = out.strip("\n").split("\n")
    assert len(lines) == 2, f"expected 2 lines, got {lines!r}"
    assert lines[0] == "1", f"card1 (valid) expected 1, got {lines[0]!r}"
    assert lines[1] == "0", (
        f"card2 (check digit off by one) expected 0, got {lines[1]!r}"
    )
    assert out == "1\n0\n", f"exact output mismatch: {out!r}"
    print("t27 hidden tests: PASS")


if __name__ == "__main__":
    main()
