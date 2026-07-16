def main():
    n_limit = 1000
    flags = [0.0] * n_limit
    n = 2
    count = 0
    while n < n_limit:
        if flags[n] == 0.0:
            count += 1
            j = n * n
            while j < n_limit:
                flags[j] = 1.0
                j += n
        n += 1
    print(count)


if __name__ == "__main__":
    main()
