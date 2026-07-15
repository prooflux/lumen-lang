class ChannelClosed:
    pass


def attempt_ratio(x: int, y: int):
    if y == 0:
        return ChannelClosed()
    return x // y


def display(r):
    if isinstance(r, ChannelClosed):
        print("channel closed")
    else:
        print(f"value {r}")


def main():
    display(attempt_ratio(42, 7))
    display(attempt_ratio(13, 0))


if __name__ == "__main__":
    main()
