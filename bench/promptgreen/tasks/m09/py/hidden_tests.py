import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "reference.py")


def run():
    out = subprocess.run(
        [sys.executable, REF], capture_output=True, text=True, check=True
    )
    return out.stdout


def main():
    stdout = run()
    assert stdout == "19512\n", f"expected '19512\\n', got {stdout!r}"

    # edge case: zero discount rate collapses to the raw payoff, scaled and rounded
    sys.path.insert(0, HERE)
    import reference

    zero_rate = round(reference.discounted_payoff(100.0, 0.0, 5.0) * 100.0)
    assert zero_rate == 10000, f"expected 10000, got {zero_rate}"

    # edge case: zero term collapses discount factor to 1 regardless of rate
    zero_term = round(reference.discounted_payoff(50.25, 0.2, 0.0) * 100.0)
    assert zero_term == 5025, f"expected 5025, got {zero_term}"

    print("all tests passed")


if __name__ == "__main__":
    main()
