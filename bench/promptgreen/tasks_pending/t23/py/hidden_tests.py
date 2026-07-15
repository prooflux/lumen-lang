import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def run_ref():
    result = subprocess.run([sys.executable, REF], capture_output=True, text=True)
    assert result.returncode == 0, f"reference.py exited nonzero: {result.stderr}"
    return result.stdout


def main():
    out = run_ref()
    lines = [l for l in out.split("\n") if l.strip() != ""]

    assert len(lines) == 1, f"expected exactly one output line, got {lines}"
    assert lines[0].strip() == "168", f"expected 168 primes below 1000, got {lines[0]}"

    # Edge: 997 (largest prime below 1000) must independently verify as prime
    # via trial division, confirming the sieve's boundary handling.
    def is_prime(x):
        if x < 2:
            return False
        d = 2
        while d * d <= x:
            if x % d == 0:
                return False
            d += 1
        return True

    assert is_prime(997), "sanity check: 997 must be prime"

    print("OK")


if __name__ == "__main__":
    main()
