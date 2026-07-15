def main() -> None:
    readings = [0.0, 0.0, 0.0]
    readings[0] = 1.25
    readings[1] = 3.75
    readings[2] = 4.0
    total = 0.0
    idx = 0
    while idx < len(readings):
        total = total + readings[idx]
        idx = idx + 1
    print(round(total * 100.0))


if __name__ == "__main__":
    main()
