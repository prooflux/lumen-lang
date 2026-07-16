import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
REF = HERE / "reference.py"


def main():
    out = subprocess.run(
        [sys.executable, str(REF)], capture_output=True, text=True, check=True
    ).stdout
    assert out == "7.929688\n", f"unexpected stdout: {out!r}"
    # edge: half-even tie must not resolve to round-half-up
    assert out.strip() != "7.929687"
    assert out.count("\n") == 1
    print("ok")


if __name__ == "__main__":
    main()
