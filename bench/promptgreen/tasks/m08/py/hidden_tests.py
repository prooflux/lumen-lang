import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")

sys.path.insert(0, HERE)
from reference import ChannelClosed, attempt_ratio  # noqa: E402


def run():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    )
    return out.stdout


def main():
    stdout = run()
    assert stdout == "value 6\nchannel closed\n", f"unexpected stdout: {stdout!r}"

    assert attempt_ratio(42, 7) == 6
    assert isinstance(attempt_ratio(13, 0), ChannelClosed)
    assert attempt_ratio(0, 5) == 0  # zero-numerator edge case

    print("all checks passed")


if __name__ == "__main__":
    main()
