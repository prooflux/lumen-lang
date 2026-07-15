# t26: weekday index from a calendar date

Write a program that computes the day-of-week index for a given calendar date
(year, month, day; a proleptic Gregorian date), producing an index in the range
0 to 6 where 0 means Saturday, 1 means Sunday, 2 means Monday, 3 means Tuesday,
4 means Wednesday, 5 means Thursday, and 6 means Friday.

Use this method: treat January and February of any year as months 13 and 14 of
the *previous* year (so, for a January or February date, subtract 1 from the year
and add 12 to the month before doing anything else). Then, with the (possibly
adjusted) year split into a century part `c` (year divided by 100, integer
division, remainder discarded) and a year-within-century part `y` (year minus
`c * 100`), and with the (possibly adjusted) month called `m` and the day called
`d`, compute:

```
h = (d + ((m + 1) * 26) / 10 + y + y / 4 + c / 4 + 5 * c) mod 7
```

where every division above is integer division (fractional part discarded) and
`mod` is the non-negative remainder after integer division by 7. `h` is the
weekday index defined above.

Run this computation for exactly these three dates, in order, and print the
resulting index for each on its own line (three lines total, one plain integer
per line, no other text):

1. year 2000, month 1, day 1 (an edge case: January, so the year/month shift
   rule above must fire; this date is a Saturday)
2. year 2026, month 7, day 15
3. year 1900, month 3, day 1 (March, so no shift rule fires; the boundary
   century year 1900 was not a leap year)

Print nothing else.
