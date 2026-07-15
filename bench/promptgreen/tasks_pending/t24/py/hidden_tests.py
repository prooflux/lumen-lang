import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def run_ref():
    result = subprocess.run([sys.executable, REF], capture_output=True, text=True)
    assert result.returncode == 0, f"reference.py exited nonzero: {result.stderr}"
    return result.stdout


def main():
    out = run_ref()
    lines = [l for l in out.split("\n") if l.strip() != ""]

    assert len(lines) == 2, f"expected exactly two output lines, got {lines}"
    steps = int(lines[0])
    peak = int(lines[1])

    assert steps == 111, f"expected 111 steps for start=27, got {steps}"
    assert peak == 9232, f"expected peak 9232 for start=27, got {peak}"

    # Edge: peak must exceed both the starting value and the step count,
    # catching a program that swaps the print order or misses updating peak.
    assert peak > 27
    assert peak > steps

    print("OK")


if __name__ == "__main__":
    main()
