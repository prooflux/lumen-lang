import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = "shipment ready: pallets units\n"


def main() -> int:
    result = subprocess.run(
        [sys.executable, os.path.join(HERE, "reference.py")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"nonzero exit: {result.returncode}"
    assert result.stdout == EXPECTED, f"got {result.stdout!r}, expected {EXPECTED!r}"
    assert result.stdout.endswith(" units\n")
    print("m03 ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
