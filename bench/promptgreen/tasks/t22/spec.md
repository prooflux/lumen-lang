# t22: linear interpolation on a curve of pillars

You are given 5 pillars of a curve, each pillar has a whole-number year and
a real-valued level:

```
year:  1     2     3     5     10
level: 0.99  0.97  0.94  0.90  0.80
```

The pillars are sorted by year, ascending.

For each of the following 3 query years, compute the interpolated level
using linear interpolation between the two neighboring pillars (if the
query year exactly matches a pillar year, the result is that pillar's
level exactly, with no interpolation error):

```
query years: 3, 4, 7
```

For each query, in the order given, output one line containing the
interpolated level multiplied by 1000000 and rounded to the nearest
integer.

You may assume every query year lies between the smallest and largest
pillar years (no extrapolation needed).

Print nothing else (no extra lines, no labels).
