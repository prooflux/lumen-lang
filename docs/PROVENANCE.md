# Provenance and extraction audit

- This repository carries the complete development history of Lumen, extracted from its
  private development monorepo with
  `git filter-repo --path projects/lumen/ --path-rename projects/lumen/:` on a fresh clone.
  Only commits touching the Lumen tree are present; authorship and dates are preserved.
- Re-extracted 2026-07-03 when Lumen graduated to this repository as its standalone home
  (superseding the 2026-07-02 initial publication, which was missing five later commits
  including the self-hosting fixpoint). History is authoritative here from this point on.
- Safety audit before publication:
  - gitleaks over all history: 159 commits scanned, no leaks found.
  - Full-history secret-pattern grep (tokens, key blocks, api keys): no hits.
  - File census of every path that ever existed: reviewed; no non-Lumen content.
  - Tip hygiene: two internal session logs moved to docs/history-notes/, absolute
    local paths rewritten to repo-relative.
- Deliberately KEPT in history: the fake self-host commits and the reward-hacked
  benchmark era, with the commits that caught and removed them. The oracle-gated
  process is the product; its failure ledger is evidence, not embarrassment.
