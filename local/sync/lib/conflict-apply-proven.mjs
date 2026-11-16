// What `conflicts.mjs --apply-proven <decision.json>` may write. Pure: file reads are injected.
//
// The decision file is `--propose --json` output, so it records what was proven, but it is never the
// authority: each file is re-proven from the bytes on disk, and anything that does not reproduce —
// edited since the proposal, hand-edited decision, partial proof — is refused rather than written.
import { proveFile, sha256 } from './conflict-prove.mjs'

const quote = (file) => (/^[\w./@+-]+$/.test(file) ? file : `'${file.replace(/'/g, "'\\''")}'`)

/**
 * @param {{ readText: (path: string) => string | null, unmerged: Set<string>, isSymlink: (path: string) => boolean, moduleExists?: (path: string) => boolean, readStages?: (path: string) => { base: string | null, ours: string | null, theirs: string | null } }} worktree
 *   `unmerged` is `git diff --name-only --diff-filter=U`: a decision may only write a path git still calls conflicted.
 *   `moduleExists` and `readStages` are the index facts `proveFile` checks a resolved file against.
 */
export function planApplyProven(
  decision,
  { readText, unmerged, isSymlink, moduleExists = null, readStages = null }
) {
  if (decision?.mode !== 'live' || !Array.isArray(decision.files)) {
    throw new Error(
      'the decision file must be `conflicts.mjs --propose --json` output from a live conflict (not --merge-tree)'
    )
  }
  if (!(unmerged instanceof Set)) {
    throw new Error(
      'the unmerged path set is required, so a decision cannot name an arbitrary path'
    )
  }
  const plan = { writes: [], already: [], removals: [], unproven: [], refused: [] }
  for (const file of decision.files) {
    if (file.proposal?.action === 'delete') {
      plan.removals.push({
        path: file.path,
        provenance: file.proposal.provenance,
        command: `git rm -- ${quote(file.path)}`
      })
      continue
    }
    const proof = file.proof
    if (!proof?.fullyProven) {
      plan.unproven.push({
        path: file.path,
        proven: proof?.provenHunks ?? 0,
        hunks: proof?.hunkCount ?? file.hunkCount ?? 0,
        // Only what blocks it: an unproven hunk's reason, or the file-level one (a modify/delete, a
        // module path that resolves to nothing) that no hunk carries.
        reasons: [
          ...new Set(
            [
              ...(proof?.hunks ?? []).filter((hunk) => !hunk.tier).map((hunk) => hunk.reason),
              proof?.reason
            ].filter(Boolean)
          )
        ],
        ledger: file.proposal ? `${file.proposal.action} (${file.proposal.provenance})` : null
      })
      continue
    }
    if (isSymlink(file.path)) {
      plan.refused.push({ path: file.path, reason: 'it is a symlink; writing would follow it' })
      continue
    }
    const current = readText(file.path)
    // A second run over the same decision finds the files the first one wrote, staged or not. They hold
    // this decision's own resolution, not an edit: on 2026-11-15 the rerun reported all 189 files the
    // first run had written as "changed since --propose" and exited 1. Nothing is written for them.
    if (current !== null && proof.resolvedSha && sha256(current) === proof.resolvedSha) {
      plan.already.push({ path: file.path, staged: !unmerged.has(file.path) })
      continue
    }
    if (!unmerged.has(file.path)) {
      plan.refused.push({ path: file.path, reason: 'git does not list it as unmerged' })
      continue
    }
    if (current === null) {
      plan.refused.push({ path: file.path, reason: 'the file is gone from the worktree' })
      continue
    }
    if (sha256(current) !== proof.mergedSha) {
      plan.refused.push({ path: file.path, reason: 'changed since --propose; re-run --propose' })
      continue
    }
    const again = proveFile({
      path: file.path,
      status: file.status ?? null,
      merged: current,
      moduleExists,
      stages: readStages ? readStages(file.path) : null
    })
    if (!again.fullyProven || again.resolvedSha !== proof.resolvedSha) {
      plan.refused.push({
        path: file.path,
        reason: 'the proof does not reproduce from the file on disk'
      })
      continue
    }
    plan.writes.push({
      path: file.path,
      text: again.resolvedText,
      tiers: [...new Set(again.hunks.map((hunk) => hunk.tier))],
      identitySweep: again.identitySweep
    })
  }
  return plan
}

/**
 * `--propose`: attach each file's proof, without its resolved text, and return the summary note.
 * `merged` and `stages` are maps by path; `moduleExists` is the merged-index oracle.
 */
export function attachProofs(files, { merged, stages, moduleExists }) {
  for (const file of files) {
    const { resolvedText: _text, ...proof } = proveFile({
      path: file.path,
      status: file.status,
      merged: merged.get(file.path) ?? null,
      moduleExists,
      stages: stages.get(file.path) ?? null
    })
    file.proof = proof
  }
  const proven = files.filter((file) => file.proof.fullyProven).length
  const hunks = files.reduce((sum, file) => sum + file.proof.hunkCount, 0)
  const provenHunks = files.reduce((sum, file) => sum + file.proof.provenHunks, 0)
  return `proof: ${provenHunks} of ${hunks} hunk(s) proven; ${proven} of ${files.length} path(s) fully proven (--apply-proven writes only those)`
}

export function renderApplyPlan(plan, written) {
  const already = plan.already ?? []
  const summary = `apply-proven: wrote ${written.length} fully proven file(s); ${already.length} already written by an earlier run, ${plan.unproven.length} not fully proven, ${plan.refused.length} refused, ${plan.removals.length} deletion(s) proposed`
  const rows = [summary]
  for (const write of plan.writes.filter((item) => written.includes(item.path))) {
    rows.push(`  wrote   ${write.path} — ${write.tiers.join(', ')}`)
  }
  for (const item of already) {
    const state = item.staged ? ' (staged)' : ''
    rows.push(`  already ${item.path} — holds the resolution this decision recorded${state}`)
  }
  for (const item of plan.refused) {
    rows.push(`  REFUSED ${item.path} — ${item.reason}`)
  }
  for (const item of plan.unproven) {
    const ledger = item.ledger ? `; ledger: ${item.ledger}` : ''
    rows.push(`  manual  ${item.path} — ${item.proven}/${item.hunks} hunk(s) proven${ledger}`)
    for (const reason of item.reasons) {
      rows.push(`          ${reason}`)
    }
  }
  if (plan.removals.length > 0) {
    rows.push('deletions the ledger or manifest settled — not run, review and run them yourself:')
    for (const item of plan.removals) {
      rows.push(`  ${item.command}    # ${item.provenance}`)
    }
  }
  const unstaged = [...written, ...already.filter((item) => !item.staged).map((item) => item.path)]
  if (unstaged.length > 0) {
    rows.push(`nothing is staged; review, then: git add -- ${unstaged.map(quote).join(' ')}`)
  }
  if (plan.writes.some((item) => item.identitySweep && written.includes(item.path))) {
    rows.push(
      'identity-only hunks were taken from upstream: run node local/sync/identity-sweep.mjs'
    )
  }
  // Again at the end: the first line scrolls away under `| tail`, and the per-file list is long.
  rows.push(summary)
  return rows.join('\n')
}
