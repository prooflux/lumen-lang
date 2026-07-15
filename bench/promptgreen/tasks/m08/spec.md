# m08: tagged outcome with a fallible operation

Write a program with:

- a tagged marker value that represents a single failure reason called "channel closed"
- a function that takes two whole numbers and attempts to divide the first by the second,
  producing either a successful whole-number outcome or the failure marker when the second
  number is zero
- a display routine that takes one such outcome and inspects it: when it is a success carrying
  a value, print the text `"value "` immediately followed by that value and a newline; when it
  is the failure marker, print the text `"channel closed"` followed by a newline
- an entry point that calls the display routine on the result of dividing 42 by 7, then calls
  the display routine again on the result of dividing 13 by 0

Print nothing else beyond those two lines.
