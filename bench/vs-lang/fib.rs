// fib.rs - Rust twin of fib.c / fib.lm, same recursive structure.
// Must print byte-identical stdout to the other twins: "2178309\n".

fn fib(n: i64) -> i64 {
    if n < 2 {
        return n;
    }
    fib(n - 1) + fib(n - 2)
}

fn main() {
    println!("{}", fib(32));
}
