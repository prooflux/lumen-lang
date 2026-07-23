/* sort.c - hand-written C twin of sort.lm, same insertion-sort structure, same fixed N=1600,
 * same deterministic fill and position-weighted checksum. Must print byte-identical stdout. */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

static void fill(int n, double *a) {
  for (int i = 0; i < n; i++) {
    a[i] = (double)(((long)i * 2654435761L + 17L) % 100003L);
  }
}

static void insertion_sort(int n, double *a) {
  for (int i = 1; i < n; i++) {
    double key = a[i];
    int j = i - 1;
    while (j >= 0 && a[j] > key) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = key;
  }
}

static double checksum(int n, double *a) {
  double total = 0.0;
  for (int i = 0; i < n; i++) {
    total += a[i] * (double)(i + 1);
  }
  return total;
}

int main(void) {
  int n = 1600;
  double *a = malloc(sizeof(double) * n);
  fill(n, a);
  insertion_sort(n, a);
  printf("%.0f\n", round(checksum(n, a)));
  free(a);
  return 0;
}
