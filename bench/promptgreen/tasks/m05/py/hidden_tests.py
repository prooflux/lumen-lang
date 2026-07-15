import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def run():
    result = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, f"reference.py exited nonzero: {result.stderr}"
    return result.stdout


def test_basic():
    out = run()
    assert out == "1950\n", f"expected 1950, got {out!r}"


def test_positive():
    out = run()
    assert int(out.strip()) > 0


def test_no_extra_output():
    out = run()
    assert out.count("\n") == 1, f"expected exactly one line, got {out!r}"


if __name__ == "__main__":
    test_basic()
    test_positive()
    test_no_extra_output()
    print("all tests passed")
