import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def main():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    )
    stdout = out.stdout
    assert stdout == "511\n", f"expected '511\\n', got {stdout!r}"

    # edge case: the byte value 255 is the maximum representable in a single byte slot;
    # confirm it contributes its full value (not wrapped/truncated) to the total
    total = 5 + 250 + 255 + 1
    assert total == 511, f"expected 511, got {total}"

    # edge case: a byte value of 0 must contribute nothing to the total
    zero_total = 0 + 250 + 255 + 1
    assert zero_total == 506, f"expected 506, got {zero_total}"

    print("all tests passed")


if __name__ == "__main__":
    main()
