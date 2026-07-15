class Rect:
    def __init__(self, width: float, height: float):
        self.width = width
        self.height = height


def area(r: Rect) -> float:
    return r.width * r.height


def main():
    r = Rect(6.5, 7.0)
    print(round(area(r)))


if __name__ == "__main__":
    main()
