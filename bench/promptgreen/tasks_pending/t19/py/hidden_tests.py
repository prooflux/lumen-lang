import os
import subprocess
import sys

d = os.path.dirname(os.path.abspath(__file__))
r = subprocess.run(
    [sys.executable, os.path.join(d, "reference.py")], capture_output=True, text=True
)
assert r.returncode == 0, f"nonzero exit: {r.returncode}"
lines = [l for l in r.stdout.split("\n") if l != ""]
assert len(lines) == 2, f"expected 2 lines, got {lines}"
assert lines[0] == "272727", f"expected 272727, got {lines[0]}"
assert lines[1] == "0", f"expected 0 (edge: monotonic rising), got {lines[1]}"
print("all checks passed")
