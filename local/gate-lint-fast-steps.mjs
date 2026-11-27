// `node local/gate-lint.mjs --fast`: the lint gate's inner-loop subset. Its own module because
// `gate-lint.mjs` is at its line budget.

/**
 * The inner-loop subset `--fast` runs: every step that reddened a PR, measured 2026-11-13 → 11-27, that
 * finishes in seconds. 37 of 118 `Fork PR gates` runs failed the lint verdict, and every one of those 37
 * failed at least one step listed here; 31 failed only steps listed here. Run together they took 45 s on
 * this machine, against ~110 s plus the queue wait for the full gate.
 *
 * Why not inside `check:code-quality:changed`: that script is upstream's and at its line budget, and most
 * of these are fork steps or whole-repo ratchets that a changed-lines scan cannot express.
 *
 * It is a subset, so a `--fast` PASS records no marker and satisfies no gate: `open-pr.mjs` still needs a
 * full run. Ids are checked against the resolved steps like `--only`, so a sync that renames one fails
 * loudly instead of running less.
 */
export const FAST_LINT_STEPS = [
  'check-upstream-file-comments',
  'check-upstream-identity-literals',
  'check-host-mesh-upstream-seams',
  'check:workspace-path-sync-fs-ratchet',
  'check:main-blocking-helper-ratchet',
  'check:main-sync-fs-ratchet',
  'check:runtime-electron-ratchet',
  'check:recurring-timer-ratchet',
  'check:max-lines-ratchet',
  'check:focus-read-ratchet',
  'verify:bundled-skill-guides',
  'verify:skill-bundle-manifest',
  'verify:localization-extraction',
  'verify:localization-catalogs',
  'verify:localization-coverage',
  'check:readme-local-links'
]
