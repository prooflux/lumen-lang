import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

out = subprocess.run(
    [sys.executable, REF], capture_output=True, text=True, check=True
).stdout
lines = out.splitlines()

assert lines[0] == "0", "2000-01-01: January shift rule must fire; Saturday"
assert lines[1] == "4", "2026-07-15: no shift rule needed"
assert lines[2] == "5", "1900-03-01: century-boundary year, non-leap"

print("all checks passed")
