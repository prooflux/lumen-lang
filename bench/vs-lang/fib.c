/* fib.c - hand-written C twin of fib.lm, line-by-line, same recursive structure.
 * Must print byte-identical stdout to the Lumen twin: "2178309\n". */
#include <stdio.h>

static long fib(long n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

int main(void) {
  printf("%ld\n", fib(32));
  return 0;
}
