# hash.py - Python twin of hash.c / hash.lm / hash.rs, same open-addressing linear-probing
# structure, same fixed N=2000 / table_size=4096, same key generator and checksum. Must print
# byte-identical stdout (an integer). Run via CPython (interpreted, no compile step):
# python3 hash.py


def make_key(i):
    return i * i * 2654435761 + i * 40503 + 104729


def probe_index(table_size, key):
    return key % table_size


def insert(table_size, table, key):
    idx = probe_index(table_size, key)
    dist = 0
    while True:
        if table[idx] == 0.0:
            table[idx] = float(key)
            return dist
        else:
            idx = (idx + 1) % table_size
            dist += 1


def lookup(table_size, table, key):
    idx = probe_index(table_size, key)
    dist = 0
    while True:
        if table[idx] == float(key):
            return dist
        else:
            idx = (idx + 1) % table_size
            dist += 1


def main():
    table_size = 4096
    n = 2000
    table = [0.0] * table_size

    total = 0
    for i in range(n):
        key = make_key(i)
        total += insert(table_size, table, key)
    for i in range(n):
        key = make_key(i)
        total += lookup(table_size, table, key)
    print(total)


if __name__ == "__main__":
    main()
