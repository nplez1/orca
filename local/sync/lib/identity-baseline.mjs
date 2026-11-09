// The frozen set of report-only identity findings, and the comparison the gate runs against it.
//
// Why a baseline: `identity-sweep.mjs` fixes the mechanical literals and reports the rest, and there
// are hundreds of the rest — so the sweep could only ever pass on `fixable === 0`, and the 2026-11-08
// sync's `managed-hook-script-path.ts` regression passed with it. The report-only findings that are
// already there are decisions nobody has made; a NEW one is a regression, and the difference between
// the two is a frozen count per rule per file. Same ratchet as `local/check-upstream-file-comments.mjs`:
// growth is refused, and the total may only move through `--baseline-prune`, so slack cannot be spent.
//
// Pure: the sweep's JSON in, a comparison out. The reads and writes live in identity-sweep.mjs.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const BASELINE_PATH = path.join('local', 'sync', 'identity-sweep-baseline.json')

/** `[{rule, file, ...}]` -> `{rules: {rule: {file: count}}, total}`, which is what gets frozen. */
export function summarizeReportOnly(reportOnly) {
  const rules = {}
  let total = 0
  for (const hit of reportOnly) {
    const perFile = (rules[hit.rule] ??= {})
    perFile[hit.file] = (perFile[hit.file] ?? 0) + 1
    total += 1
  }
  return { rules: sortedRules(rules), total }
}

function sortedRules(rules) {
  const out = {}
  for (const rule of Object.keys(rules).sort()) {
    const files = {}
    for (const file of Object.keys(rules[rule]).sort()) {
      files[file] = rules[rule][file]
    }
    out[rule] = files
  }
  return out
}

export function buildBaseline(reportOnly, { base, accepted = null, note }) {
  const { rules, total } = summarizeReportOnly(reportOnly)
  return { note, base, ...(accepted ? { accepted } : {}), total, rules }
}

/**
 * `counts` is the frozen baseline's per-rule-per-file counts. A rule the baseline has never seen fails
 * on its pairs, not on the rule existing: adding a rule to the sweep is a change to the sweep, and
 * what matters is the findings that rule then makes in files the baseline did not know about.
 */
export function compareIdentityBaseline({ baseline, reportOnly }) {
  const { rules: current, total } = summarizeReportOnly(reportOnly)
  const frozen = baseline?.rules ?? {}
  const appeared = []
  const grown = []
  for (const rule of Object.keys(current)) {
    for (const [file, count] of Object.entries(current[rule])) {
      const allowed = frozen[rule]?.[file]
      if (allowed === undefined) {
        appeared.push({ rule, file, count })
      } else if (count > allowed) {
        grown.push({ rule, file, count, allowed })
      }
    }
  }
  const stale = []
  for (const rule of Object.keys(frozen)) {
    for (const [file, allowed] of Object.entries(frozen[rule])) {
      if (current[rule]?.[file] === undefined) {
        stale.push({ rule, file, allowed })
      }
    }
  }
  const totalAllowed = baseline?.total ?? 0
  return {
    appeared,
    grown,
    stale,
    total,
    totalAllowed,
    // Growth is a red; a shrink is a red only because the baseline has to be pruned to lock it in,
    // which is what stops the freed slack being spent on a different file.
    over: total > totalAllowed,
    shrunk: total < totalAllowed,
    clean: appeared.length === 0 && grown.length === 0 && total === totalAllowed
  }
}

/** The baseline file, or `{ baseline: null, problem }` — an unreadable baseline is never "no findings". */
export function readIdentityBaseline(root) {
  const file = path.join(root, BASELINE_PATH)
  if (!existsSync(file)) {
    return { baseline: null, problem: `${BASELINE_PATH} is missing` }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.total !== 'number') {
      return { baseline: null, problem: `${BASELINE_PATH} has no numeric total` }
    }
    return { baseline: parsed, problem: null }
  } catch (error) {
    return { baseline: null, problem: `${BASELINE_PATH} is not valid JSON: ${error.message}` }
  }
}

/**
 * Whether a baseline rewrite may proceed without `--accept`. A pair that appeared and a pair whose
 * count grew are both new findings, and neither may be recorded silently — including by `--prune`,
 * whose whole claim is that it only ever lowers. A shrink is not growth: it is what prune is for.
 */
export function rewriteRefusal({ mode, comparison }) {
  const appeared = comparison.appeared.length
  const grown = comparison.grown.length
  // `over` covers a baseline whose recorded total sits below the sum of its own counts: no pair moved,
  // and a rewrite would still raise the total the help text promises prune never raises.
  if (appeared === 0 && grown === 0 && !comparison.over) {
    return null
  }
  const what =
    appeared === 0 && grown === 0
      ? `a total of ${comparison.total} against a frozen ${comparison.totalAllowed}`
      : `${appeared} new and ${grown} grown rule/file pair(s)`
  return mode === 'prune'
    ? `--baseline-prune would record ${what}, and it only ever lowers. Fix them, or run --baseline-init --accept <reason> when they are not this branch\u2019s to fix.`
    : `${what} need --accept <reason>: the baseline may only absorb growth someone signed for.`
}

/** What a reader of the report needs: which pairs moved, and what to do about each. */
export function describeComparison(comparison) {
  const details = [
    `report-only baseline: ${comparison.total}/${comparison.totalAllowed} finding(s)`,
    ...comparison.appeared.map(
      ({ rule, file, count }) => `  ! ${rule}: ${file} — new (${count}), not in the baseline`
    ),
    ...comparison.grown.map(
      ({ rule, file, count, allowed }) => `  ! ${rule}: ${file} — ${count}, baseline ${allowed}`
    ),
    ...(comparison.over
      ? [`  ! total ${comparison.total} exceeds the frozen ${comparison.totalAllowed}`]
      : []),
    ...(comparison.shrunk
      ? [
          `  ? total fell to ${comparison.total} from ${comparison.totalAllowed} — run \`node local/sync/identity-sweep.mjs --baseline-prune\` so the shrink cannot be spent again`
        ]
      : []),
    ...(comparison.stale.length === 0
      ? []
      : [
          `  ? ${comparison.stale.length} baseline entr(ies) no longer carry a finding — prune them`
        ]),
    ...comparison.stale
      .slice(0, 30)
      .map(({ rule, file, allowed }) => `  ? ${rule}: ${file} — was ${allowed}, now 0`)
  ]
  return details
}
