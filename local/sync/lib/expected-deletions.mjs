/**
 * The manifest of files this fork deletes that upstream still owns.
 *
 * Every such path is a modify/delete conflict on the next sync, and the resolver used to print it as
 * a bare conflict with no answer — so a human re-decided it, or worse, resolved it by restoring the
 * file. This module reads the manifest that answers it, as one of three statuses: the deletion is the
 * fork's answer, nobody has decided yet, or the file comes back. Pure: no git, no filesystem.
 */
export const EXPECTED_DELETION_STATUSES = ['expected-deletion', 'pending-decision', 'restore']

const DEFAULT_STATUS = 'expected-deletion'

/**
 * Tolerant reader: a malformed manifest must never stop a conflict triage, so a parse failure is a
 * note rather than a throw. Duplicate paths and unknown statuses are reported the same way, because
 * either one silently changes what the resolver says about a file.
 */
export function parseExpectedDeletions(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], note: `expected-deletions.json is not valid JSON: ${error.message}` }
  }
  const raw = Array.isArray(parsed?.deletions) ? parsed.deletions : []
  const problems = []
  const entries = []
  for (const item of raw) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    if (path === '') {
      problems.push('an entry has no path')
      continue
    }
    const status = item.status ?? DEFAULT_STATUS
    if (!EXPECTED_DELETION_STATUSES.includes(status)) {
      problems.push(`${path}: unknown status "${status}"`)
    }
    entries.push({
      path,
      status,
      class: item.class ?? 'unclassified',
      commit: item.commit ?? null,
      reason: item.reason ?? ''
    })
  }
  const counts = new Map()
  for (const entry of entries) {
    counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1)
  }
  for (const [path, count] of counts) {
    if (count > 1) {
      problems.push(`${path} is listed ${count} times`)
    }
  }
  return { entries, note: problems.length === 0 ? null : problems.join(' | ') }
}

export function deletionFor(entries, path) {
  return entries.find((entry) => entry.path === path) ?? null
}

/** The conflicted paths whose deletion nobody has settled, which is what a triage must not skip. */
export function pendingDeletionPaths(entries, paths) {
  const conflicted = new Set(paths)
  return entries
    .filter((entry) => entry.status === 'pending-decision' && conflicted.has(entry.path))
    .map((entry) => entry.path)
}

/**
 * A manifest that says "deleted" about a path present at HEAD is stale, and a stale manifest is how a
 * restored file gets silently deleted again on the next sync. `presentAtHead` is a Set of paths.
 */
export function staleDeletions(entries, presentAtHead) {
  return entries
    .filter((entry) => entry.status !== 'restore' && presentAtHead.has(entry.path))
    .map((entry) => entry.path)
}

/**
 * The `symbols` half of the manifest: fork-added names a merge removed on purpose. Same statuses as a
 * file entry; only `expected-deletion` silences the survival check, and `restore` says it must return.
 */
export function parseExpectedSymbols(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], note: `expected-deletions.json is not valid JSON: ${error.message}` }
  }
  const problems = []
  const entries = []
  const seen = new Set()
  for (const item of Array.isArray(parsed?.symbols) ? parsed.symbols : []) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    const symbol = typeof item?.symbol === 'string' ? item.symbol.trim() : ''
    if (path === '' || symbol === '') {
      problems.push('a symbols entry needs both path and symbol')
      continue
    }
    const status = item.status ?? 'pending-decision'
    if (!EXPECTED_DELETION_STATUSES.includes(status)) {
      problems.push(`${path}#${symbol}: unknown status "${status}"`)
    }
    if (seen.has(`${path}#${symbol}`)) {
      problems.push(`${path}#${symbol} is listed twice`)
    }
    seen.add(`${path}#${symbol}`)
    entries.push({
      path,
      symbol,
      status,
      supersededBy: item.supersededBy ?? null,
      reason: item.reason ?? ''
    })
  }
  return { entries, note: problems.length === 0 ? null : problems.join(' | ') }
}
