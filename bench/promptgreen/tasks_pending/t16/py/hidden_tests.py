import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
REF = HERE / "reference.py"


def main():
    out = subprocess.run(
        [sys.executable, str(REF)], capture_output=True, text=True, check=True
    ).stdout
    assert out == "153061\n", f"unexpected stdout: {out!r}"
    # edge: catches sign/discount/permutation-count errors
    assert out.strip() != "150000"
    assert out.count("\n") == 1
    print("ok")


if __name__ == "__main__":
    main()
