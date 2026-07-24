// sort.rs - Rust twin of sort.c / sort.lm, same insertion-sort structure, same fixed N=1600,
// same deterministic fill and position-weighted checksum. Must print byte-identical stdout.

fn fill(n: usize, a: &mut [f64]) {
    for i in 0..n {
        a[i] = ((i as i64) * 2654435761i64 + 17i64).rem_euclid(100003i64) as f64;
    }
}

fn insertion_sort(n: usize, a: &mut [f64]) {
    for i in 1..n {
        let key = a[i];
        let mut j = i as i64 - 1;
        while j >= 0 && a[j as usize] > key {
            a[(j + 1) as usize] = a[j as usize];
            j -= 1;
        }
        a[(j + 1) as usize] = key;
    }
}

fn checksum(n: usize, a: &[f64]) -> f64 {
    let mut total = 0.0f64;
    for i in 0..n {
        total += a[i] * ((i + 1) as f64);
    }
    total
}

fn main() {
    let n: usize = 1600;
    let mut a = vec![0.0f64; n];
    fill(n, &mut a);
    insertion_sort(n, &mut a);
    println!("{:.0}", checksum(n, &a).round());
}
