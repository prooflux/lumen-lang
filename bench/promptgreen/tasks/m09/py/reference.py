def discounted_payoff(payoff: float, discount_rate: float, term: float) -> float:
    return payoff / (1.0 + discount_rate) ** term


def main() -> None:
    result = round(discounted_payoff(245.80, 0.08, 3.0) * 100.0)
    print(result)


if __name__ == "__main__":
    main()
