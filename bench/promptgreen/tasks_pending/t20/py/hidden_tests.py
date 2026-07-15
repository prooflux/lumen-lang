import os
import subprocess
import sys

d = os.path.dirname(os.path.abspath(__file__))
r = subprocess.run(
    [sys.executable, os.path.join(d, "reference.py")], capture_output=True, text=True
)
assert r.returncode == 0, f"nonzero exit: {r.returncode}"
lines = [l for l in r.stdout.split("\n") if l != ""]
assert len(lines) == 3, f"expected 3 lines, got {lines}"
assert lines[0] == "1200000", f"expected 1200000, got {lines[0]}"
assert lines[1] == "142829", f"expected 142829, got {lines[1]}"
assert lines[2] == "0", f"expected 0 (edge: orthogonal vectors), got {lines[2]}"
print("all checks passed")
