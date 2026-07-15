import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
EXPECTED = "3000000\n0\n1000000\n"


def main():
    result = subprocess.run(
        [sys.executable, str(HERE / "reference.py")],
        capture_output=True,
        text=True,
        check=True,
    )
    got = result.stdout
    lines = [l for l in got.split("\n") if l]

    assert got == EXPECTED, f"full output mismatch: {got!r} != {EXPECTED!r}"
    assert lines[0] == "3000000", "case 1 (target=30, [0,5]) should be exact root 3"
    assert lines[1] == "0", (
        "edge case: target=0 on [-5,5] must resolve to root 0 exactly"
    )
    assert lines[2] == "1000000", "case 3 (target=2, [0,2]) should be exact root 1"

    print("all hidden tests passed")


if __name__ == "__main__":
    main()
