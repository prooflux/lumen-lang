def within_bounds(reading: int, lower: int, upper: int) -> int:
    if reading >= lower and reading <= upper:
        return 1
    return 0


def main() -> None:
    print(within_bounds(7, 3, 7))
    print(within_bounds(20, 3, 7))


if __name__ == "__main__":
    main()
