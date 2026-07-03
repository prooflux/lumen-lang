# Contributing

Lumen improves through one loop: write real Lumen, hit friction, turn the friction into a
failing test, make the minimal seed/compiler change that turns it green, prove no speed
regression (`node seed/perf.mjs`), land it. One change per PR, failing-test-first.

All gates must stay green: `cd seed && npm test`, plus the native gates in `native/`.
The interpreter is the reference oracle; the backend is never allowed to disagree with it.

By contributing you certify the Developer Certificate of Origin (developercertificate.org);
sign commits with `git commit -s`.
