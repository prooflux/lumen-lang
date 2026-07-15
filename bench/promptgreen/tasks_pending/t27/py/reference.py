def luhn_check(digits, n):
    total = 0
    i = n - 1
    pos = 0
    while i >= 0:
        d = digits[i]
        if pos % 2 == 1:
            d = d * 2
            if d > 9:
                d = d - 9
        total = total + d
        pos = pos + 1
        i = i - 1
    if total % 10 == 0:
        return 1
    else:
        return 0


def main():
    card1 = [4, 5, 3, 2, 0, 1, 5, 1, 1, 2, 8, 3, 0, 3, 6, 6]
    card2 = [4, 5, 3, 2, 0, 1, 5, 1, 1, 2, 8, 3, 0, 3, 6, 7]
    print(luhn_check(card1, len(card1)))
    print(luhn_check(card2, len(card2)))


if __name__ == "__main__":
    main()
