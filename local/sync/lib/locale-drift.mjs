// The locale tombstone rule, as a check.
//
// LOCAL-PATCHES.md § local(i18n): upstream owns every file under `src/renderer/src/i18n/locales/`
// byte-for-byte, and the fork's own strings and its orphan tombstones live in `i18n/fork/*.json`. The
// rule was written down and then broken by the 2026-11-08 sync, which deleted three keys from each of
// the 11 catalogs — the twelve highest-churn paths in the tree — so every one of them will conflict
// again on the next sync for no reason.
//
// The ruler is the upstream merge base, not `upstream/main`: on a synced tree the merge base *is* the
// sync base, and upstream moves between syncs, so diffing the tip would report red with zero fork
// drift. Same base `local/check-upstream-file-comments.mjs` measures against.
//
// Pure: the changed-path list in, a verdict out.

export const LOCALES_DIR = 'src/renderer/src/i18n/locales'

export function localeDriftReport({ base, changed }) {
  const files = [...changed].sort()
  return {
    base,
    files,
    clean: files.length === 0,
    detail:
      files.length === 0
        ? `${LOCALES_DIR}/ is byte-identical to upstream at ${base.slice(0, 10)}`
        : `${files.length} locale file(s) differ from upstream at ${base.slice(0, 10)}`
  }
}
