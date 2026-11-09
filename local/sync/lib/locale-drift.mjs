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
// The pure part is `localeDriftReport`; `localeDrift()` is the post-sync row, which places the ruler
// and reads the diff.

import { STATUS, changedNames, gitText } from './run.mjs'
import { UPSTREAM_REF } from './sync-range.mjs'

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

// ---- locale tombstones -----------------------------------------------------------------------

/**
 * `src/renderer/src/i18n/locales/` must be upstream's, byte-for-byte.
 *
 * LOCAL-PATCHES.md § local(i18n) says so and nothing enforced it, so the 2026-11-08 sync deleted
 * three keys from all 11 catalogs — the twelve highest-churn paths in the tree — which is 11 files
 * that will conflict again on the next sync for no reason at all. The fork's own strings and its
 * orphan tombstones live in `i18n/fork/*.json`.
 */
export function localeDrift() {
  const base = gitText(['merge-base', 'HEAD', UPSTREAM_REF])
  if (!base) {
    return {
      status: STATUS.unavailable,
      summary: `${UPSTREAM_REF} is not fetched, so the locale ruler cannot be placed`,
      details: ['run: git fetch upstream']
    }
  }
  const changed = changedNames([base, 'HEAD', '--', LOCALES_DIR])
  if (changed === null) {
    return {
      status: STATUS.failed,
      summary: `git diff ${base.slice(0, 10)}..HEAD failed for ${LOCALES_DIR}/`,
      details: ['an unreadable diff is not an empty one']
    }
  }
  const report = localeDriftReport({ base, changed })
  return {
    status: report.clean ? STATUS.passed : STATUS.failed,
    summary: report.detail,
    details: [
      ...report.files.map((file) => `  ! ${file}`),
      ...(report.clean
        ? []
        : [
            'restore the file to upstream and tombstone the key in src/renderer/src/i18n/fork/<lang>.json:',
            '  git checkout <upstream-base> -- src/renderer/src/i18n/locales/'
          ])
    ]
  }
}
