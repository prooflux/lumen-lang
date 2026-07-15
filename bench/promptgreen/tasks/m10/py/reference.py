def main() -> None:
    memory = {}
    memory[600000] = 5
    memory[600001] = 250
    memory[600002] = 255
    memory[600003] = 1
    total = memory[600000] + memory[600001] + memory[600002] + memory[600003]
    print(total)


if __name__ == "__main__":
    main()
