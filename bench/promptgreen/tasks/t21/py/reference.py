def main():
    a = [5.5] * 10
    for i in range(0, 8):
        s = a[i] + a[i + 1] + a[i + 2]
        m = s / 3.0
        print(round(m * 10000.0))


if __name__ == "__main__":
    main()
