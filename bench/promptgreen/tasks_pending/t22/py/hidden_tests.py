import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    ).stdout
    lines = [l for l in out.strip().split("\n") if l]
    assert len(lines) == 3, f"expected 3 lines, got {len(lines)}"
    assert lines[0] == "940000", f"exact-pillar query wrong: {lines[0]}"
    assert lines[1] == "920000", f"midpoint query wrong: {lines[1]}"
    assert lines[2] == "860000", f"off-grid query wrong: {lines[2]}"
    expected = "940000\n920000\n860000\n"
    assert out == expected, f"expected {expected!r}, got {out!r}"
    print("OK")


if __name__ == "__main__":
    main()
