/* __builtin_popcountll is a real compiler-provided (GCC/Clang) primitive, executed here
   like any other C library entry point: the point of a C oracle is a live foreign
   implementation, not a hand-rolled Lumen-side reimplementation pretending to be one. */
long long popcount(long long x) {
    return (long long)__builtin_popcountll((unsigned long long)x);
}
