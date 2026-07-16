import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

out = subprocess.run(
    [sys.executable, REF], capture_output=True, text=True, check=True
).stdout
lines = out.splitlines()

assert lines[0] == "2" and lines[1] == "3", "9875 -> root 2, persistence 3"
assert lines[2] == "7" and lines[3] == "0", "single digit input, no steps"
assert lines[4] == "0" and lines[5] == "0", "edge case: zero input"

print("all checks passed")
