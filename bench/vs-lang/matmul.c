/* matmul.c - hand-written C twin of matmul.lm, same structure, same fixed N=38, same
 * deterministic fill formulas and checksum. Must print byte-identical stdout: same integer
 * checksum. Uses malloc'd flat arrays (not stack VLAs) to mirror Lumen's heap-backed Array. */
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

static int idx(int n, int i, int j) {
  return i * n + j;
}

static void fill(int n, double *arr, int is_a) {
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      if (is_a > 0) {
        arr[idx(n, i, j)] = (double)((i * 7 + j * 3) % 13);
      } else {
        arr[idx(n, i, j)] = (double)((i * 5 + j * 11) % 17);
      }
    }
  }
}

static void matmul(int n, double *a, double *b, double *c) {
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      double sum = 0.0;
      for (int k = 0; k < n; k++) {
        sum += a[idx(n, i, k)] * b[idx(n, k, j)];
      }
      c[idx(n, i, j)] = sum;
    }
  }
}

static double checksum(int n, double *c) {
  double total = 0.0;
  for (int i = 0; i < n * n; i++) {
    total += c[i];
  }
  return total;
}

int main(void) {
  int n = 38;
  double *a = malloc(sizeof(double) * n * n);
  double *b = malloc(sizeof(double) * n * n);
  double *c = malloc(sizeof(double) * n * n);
  fill(n, a, 1);
  fill(n, b, 0);
  matmul(n, a, b, c);
  printf("%.0f\n", round(checksum(n, c)));
  free(a); free(b); free(c);
  return 0;
}
