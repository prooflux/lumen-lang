// hash.rs - Rust twin of hash.c / hash.lm, same open-addressing linear-probing structure,
// same fixed N=2000 / table_size=4096, same key generator and checksum. Must print
// byte-identical stdout (an integer).

fn make_key(i: i64) -> i64 {
    i * i * 2654435761i64 + i * 40503i64 + 104729i64
}

fn probe_index(table_size: i64, key: i64) -> usize {
    (key % table_size) as usize
}

fn insert(table_size: usize, table: &mut [f64], key: i64) -> i64 {
    let mut idx = probe_index(table_size as i64, key);
    let mut dist: i64 = 0;
    loop {
        if table[idx] == 0.0 {
            table[idx] = key as f64;
            return dist;
        } else {
            idx = (idx + 1) % table_size;
            dist += 1;
        }
    }
}

fn lookup(table_size: usize, table: &[f64], key: i64) -> i64 {
    let mut idx = probe_index(table_size as i64, key);
    let mut dist: i64 = 0;
    loop {
        if table[idx] == key as f64 {
            return dist;
        } else {
            idx = (idx + 1) % table_size;
            dist += 1;
        }
    }
}

fn main() {
    let table_size: usize = 4096;
    let n: i64 = 2000;
    let mut table = vec![0.0f64; table_size];

    let mut total: i64 = 0;
    for i in 0..n {
        let key = make_key(i);
        total += insert(table_size, &mut table, key);
    }
    for i in 0..n {
        let key = make_key(i);
        total += lookup(table_size, &table, key);
    }
    println!("{}", total);
}
