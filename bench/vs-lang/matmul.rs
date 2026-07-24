// matmul.rs - Rust twin of matmul.c / matmul.lm, same structure, same fixed N=38, same
// deterministic fill formulas and checksum. Must print byte-identical stdout: same integer
// checksum. Uses a Vec<f64> (heap-allocated flat array) to mirror the C twin's malloc'd array.

fn idx(n: usize, i: usize, j: usize) -> usize {
    i * n + j
}

fn fill(n: usize, arr: &mut [f64], is_a: bool) {
    for i in 0..n {
        for j in 0..n {
            if is_a {
                arr[idx(n, i, j)] = ((i * 7 + j * 3) % 13) as f64;
            } else {
                arr[idx(n, i, j)] = ((i * 5 + j * 11) % 17) as f64;
            }
        }
    }
}

fn matmul(n: usize, a: &[f64], b: &[f64], c: &mut [f64]) {
    for i in 0..n {
        for j in 0..n {
            let mut sum = 0.0f64;
            for k in 0..n {
                sum += a[idx(n, i, k)] * b[idx(n, k, j)];
            }
            c[idx(n, i, j)] = sum;
        }
    }
}

fn checksum(n: usize, c: &[f64]) -> f64 {
    let mut total = 0.0f64;
    for i in 0..(n * n) {
        total += c[i];
    }
    total
}

fn main() {
    let n: usize = 38;
    let mut a = vec![0.0f64; n * n];
    let mut b = vec![0.0f64; n * n];
    let mut c = vec![0.0f64; n * n];
    fill(n, &mut a, true);
    fill(n, &mut b, false);
    matmul(n, &a, &b, &mut c);
    println!("{:.0}", checksum(n, &c).round());
}
