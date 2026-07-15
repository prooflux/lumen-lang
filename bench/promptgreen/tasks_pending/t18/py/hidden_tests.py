import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
EXPECTED = "40000\n0\n20000\n"


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
    assert lines[0] == "40000", "point=2 should give p(2)=4"
    assert lines[1] == "0", (
        "edge case: point=-2 alternating signs must resolve to root 0 exactly"
    )
    assert lines[2] == "20000", "point=0 should collapse to constant term 2"

    print("all hidden tests passed")


if __name__ == "__main__":
    main()
