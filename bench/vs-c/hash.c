/* hash.c - hand-written C twin of hash.lm, same open-addressing linear-probing structure, same
 * fixed N=2000 / table_size=4096, same key generator and checksum. Must print byte-identical
 * stdout (an integer). See hash.lm's header comment for why this stands in for the
 * "string-processing loop" bench category. */
#include <stdio.h>
#include <stdlib.h>

static long make_key(long i) {
  return i * i * 2654435761L + i * 40503L + 104729L;
}

static int probe_index(int table_size, long key) {
  return (int)(key % table_size);
}

static int insert(int table_size, double *table, long key) {
  int idx = probe_index(table_size, key);
  int dist = 0;
  int placed = 0;
  while (!placed) {
    if (table[idx] == 0.0) {
      table[idx] = (double)key;
      placed = 1;
    } else {
      idx = (idx + 1) % table_size;
      dist++;
    }
  }
  return dist;
}

static int lookup(int table_size, double *table, long key) {
  int idx = probe_index(table_size, key);
  int dist = 0;
  int found = 0;
  while (!found) {
    if (table[idx] == (double)key) {
      found = 1;
    } else {
      idx = (idx + 1) % table_size;
      dist++;
    }
  }
  return dist;
}

int main(void) {
  int table_size = 4096;
  int n = 2000;
  double *table = malloc(sizeof(double) * table_size);
  for (int i = 0; i < table_size; i++) table[i] = 0.0;

  long total = 0;
  for (int i = 0; i < n; i++) {
    long key = make_key(i);
    total += insert(table_size, table, key);
  }
  for (int i = 0; i < n; i++) {
    long key = make_key(i);
    total += lookup(table_size, table, key);
  }
  printf("%ld\n", total);
  free(table);
  return 0;
}
