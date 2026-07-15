import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = "1013.7\n1027.58769\n1041.665641\n1055.93646\n1070.40279\n"


def main():
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, "reference.py")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"nonzero exit: {result.returncode}, stderr={result.stderr}"
    )
    assert result.stdout == EXPECTED, f"expected {EXPECTED!r}, got {result.stdout!r}"

    lines = [l for l in result.stdout.split("\n") if l]
    assert len(lines) == 5, f"expected 5 lines, got {len(lines)}"
    assert lines[1] == "1027.58769", f"period-2 edge mismatch: {lines[1]!r}"

    print("ok")


if __name__ == "__main__":
    main()
