def notice(item: str) -> str:
    return "shipment ready: " + item + " units\n"


def main() -> None:
    print(notice("pallets"), end="")


if __name__ == "__main__":
    main()
