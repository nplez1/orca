/**
 * The manifest of files this fork deletes that upstream still owns.
 *
 * Every such path is a modify/delete conflict on the next sync, and the resolver used to print it as
 * a bare conflict with no answer — so a human re-decided it, or worse, resolved it by restoring the
 * file. This module reads the manifest that answers it, as one of three statuses: the deletion is the
 * fork's answer, nobody has decided yet, or the file comes back. Pure: no git, no filesystem.
 */
export const EXPECTED_DELETION_STATUSES = ['expected-deletion', 'pending-decision', 'restore']

const BLOB = /^[0-9a-f]{40}([0-9a-f]{24})?$/

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
      // The upstream blob this decision was judged against. A decision about one version of a file does
      // not carry to another, so a changed blob turns the entry back into a question.
      upstreamBlob: item.upstreamBlob ?? null,
      reason: item.reason ?? ''
    })
    if (item.upstreamBlob != null && !BLOB.test(String(item.upstreamBlob))) {
      problems.push(`${path}: upstreamBlob "${item.upstreamBlob}" is not a blob SHA`)
    }
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
 * The entry as this sync may read it. Upstream repurposing a file changes its blob, and a `delete`
 * judged against the old one must not keep proposing `git rm -f` against the new. `upstreamBlob` is
 * the path's blob in the upstream tree being merged, or null when it cannot be read (upstream deleted
 * the path, or the ref does not resolve) — an answer nobody can check is not evidence the decision
 * changed.
 */
export function boundDeletion(entry, upstreamBlob) {
  if (!entry || !entry.upstreamBlob || !upstreamBlob) {
    return { entry, rebound: false }
  }
  return entry.upstreamBlob === upstreamBlob
    ? { entry, rebound: false }
    : { entry: { ...entry, status: 'pending-decision' }, rebound: true }
}

/**
 * Entries neither side has any more: upstream deleted the file and so did the fork, so the entry can
 * never conflict again. `staleDeletions` only catches the opposite case (the file came back).
 */
export function prunableDeletions(entries, { presentAtHead, presentUpstream }) {
  return entries
    .filter((entry) => !presentAtHead.has(entry.path) && !presentUpstream.has(entry.path))
    .map((entry) => entry.path)
}

/**
 * The manifest as one sync may read it: entries with the binding applied, plus the one note a report
 * shows. `presentUpstream` is null when the upstream tree cannot be read, which makes pruning unknown
 * rather than clean; `upstreamBlobOf` answers null for a path upstream no longer has, which leaves that
 * entry's status alone — a question nobody can check is not evidence the decision changed.
 */
export function readDeletionManifest({
  text,
  manifestPath = 'local/sync/expected-deletions.json',
  presentAtHead,
  presentUpstream = null,
  upstreamBlobOf = null
}) {
  if (text === null) {
    return {
      entries: [],
      prunable: [],
      rebind: 0,
      failure: null,
      note: `no deletion manifest at ${manifestPath}`
    }
  }
  const { entries, note: parseNote } = parseExpectedDeletions(text)
  const problems = []
  const stale = staleDeletions(entries, presentAtHead)
  if (stale.length > 0) {
    problems.push(`manifest calls deleted but HEAD still has: ${stale.join('; ')}`)
  }
  const prunable =
    presentUpstream === null ? [] : prunableDeletions(entries, { presentAtHead, presentUpstream })
  if (prunable.length > 0) {
    problems.push(`both sides deleted it, so the entry can be pruned: ${prunable.join('; ')}`)
  }
  const rebound = []
  const bound = entries.map((entry) => {
    const result = boundDeletion(entry, upstreamBlobOf === null ? null : upstreamBlobOf(entry.path))
    if (result.rebound) {
      rebound.push(`${entry.path} (judged ${entry.upstreamBlob.slice(0, 10)})`)
    }
    return result.entry
  })
  if (rebound.length > 0) {
    problems.push(
      `judged against an upstream blob that has changed, so these are questions again: ${rebound.join('; ')}`
    )
  }
  return {
    entries: bound,
    prunable,
    rebound,
    // `failure` is the manifest being untrustworthy; `note` is everything a reader should see.
    failure: parseNote,
    note: [parseNote, ...problems].filter(Boolean).join(' | ') || null
  }
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
