def footprint(width: float, depth: float) -> float:
    return width * depth


def main() -> None:
    print(round(footprint(3.25, 6.0) * 100.0))


if __name__ == "__main__":
    main()
