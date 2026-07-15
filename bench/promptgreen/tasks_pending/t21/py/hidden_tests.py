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
    assert len(lines) == 8, f"expected 8 lines, got {len(lines)}"
    assert all(l == "55000" for l in lines), f"expected all 55000, got {lines}"
    expected = "55000\n" * 8
    assert out == expected, f"expected {expected!r}, got {out!r}"
    print("OK")


if __name__ == "__main__":
    main()
