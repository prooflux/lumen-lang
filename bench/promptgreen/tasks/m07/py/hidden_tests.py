import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

sys.path.insert(0, HERE)
from reference import Rect, area  # noqa: E402


def run():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    )
    return out.stdout


def main():
    stdout = run()
    assert stdout == "46\n", f"expected '46\\n', got {stdout!r}"

    # direct unit checks, including the rounding-tie edge and a zero case
    assert area(Rect(6.5, 7.0)) == 45.5
    assert round(area(Rect(6.5, 7.0))) == 46
    assert area(Rect(0.0, 9.0)) == 0.0

    print("all checks passed")


if __name__ == "__main__":
    main()
