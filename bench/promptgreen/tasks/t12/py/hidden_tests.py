import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    ).stdout
    lines = out.rstrip("\n").split("\n")
    assert lines[0:3] == ["33.36", "33.36", "33.35"], (
        f"uneven split mismatch: {lines[0:3]!r}"
    )
    assert lines[3:6] == ["30.0", "30.0", "30.0"], (
        f"even split (edge case) mismatch: {lines[3:6]!r}"
    )
    assert out == "33.36\n33.36\n33.35\n30.0\n30.0\n30.0\n", (
        f"unexpected extra output: {out!r}"
    )
    print("t12 OK")


if __name__ == "__main__":
    main()
