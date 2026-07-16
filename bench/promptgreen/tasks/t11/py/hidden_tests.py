import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    ).stdout
    lines = out.split("\n")
    assert lines[0] == "1060.0", f"normal case mismatch: {lines[0]!r}"
    assert lines[1] == "333.333333", f"edge case (zero rate) mismatch: {lines[1]!r}"
    assert out == "1060.0\n333.333333\n", f"unexpected extra output: {out!r}"
    print("t11 OK")


if __name__ == "__main__":
    main()
