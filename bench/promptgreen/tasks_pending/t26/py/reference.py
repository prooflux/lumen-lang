def weekday(year, month, day):
    y = year
    m = month
    if m < 3:
        y = y - 1
        m = m + 12
    c = y // 100
    yy = y - c * 100
    raw = day + ((m + 1) * 26) // 10 + yy + yy // 4 + c // 4 + 5 * c
    h = raw - (raw // 7) * 7
    print(h)


def main():
    weekday(2000, 1, 1)
    weekday(2026, 7, 15)
    weekday(1900, 3, 1)


if __name__ == "__main__":
    main()
