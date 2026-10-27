// What `conflicts.mjs --apply-proven <decision.json>` may write. Pure: file reads are injected.
//
// The decision file is `--propose --json` output, so it records what was proven, but it is never the
// authority: each file is re-proven from the bytes on disk, and anything that does not reproduce —
// edited since the proposal, hand-edited decision, partial proof — is refused rather than written.
import { proveFile, sha256 } from './conflict-prove.mjs'

const quote = (file) => (/^[\w./@+-]+$/.test(file) ? file : `'${file.replace(/'/g, "'\\''")}'`)

/**
 * @param {{ readText: (path: string) => string | null, unmerged: Set<string>, isSymlink: (path: string) => boolean }} worktree
 *   `unmerged` is `git diff --name-only --diff-filter=U`: a decision may only write a path git still calls conflicted.
 */
export function planApplyProven(decision, { readText, unmerged, isSymlink }) {
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
  const plan = { writes: [], removals: [], unproven: [], refused: [] }
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
        reasons: [...new Set((proof?.hunks ?? []).map((hunk) => hunk.reason).filter(Boolean))],
        ledger: file.proposal ? `${file.proposal.action} (${file.proposal.provenance})` : null
      })
      continue
    }
    if (!unmerged.has(file.path)) {
      plan.refused.push({ path: file.path, reason: 'git does not list it as unmerged' })
      continue
    }
    if (isSymlink(file.path)) {
      plan.refused.push({ path: file.path, reason: 'it is a symlink; writing would follow it' })
      continue
    }
    const current = readText(file.path)
    if (current === null) {
      plan.refused.push({ path: file.path, reason: 'the file is gone from the worktree' })
      continue
    }
    if (sha256(current) !== proof.mergedSha) {
      plan.refused.push({ path: file.path, reason: 'changed since --propose; re-run --propose' })
      continue
    }
    const again = proveFile({ path: file.path, status: file.status ?? null, merged: current })
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

export function renderApplyPlan(plan, written) {
  const rows = [
    `apply-proven: wrote ${written.length} fully proven file(s); ${plan.unproven.length} not fully proven, ${plan.refused.length} refused, ${plan.removals.length} deletion(s) proposed`
  ]
  for (const write of plan.writes.filter((item) => written.includes(item.path))) {
    rows.push(`  wrote   ${write.path} — ${write.tiers.join(', ')}`)
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
  if (written.length > 0) {
    rows.push(`nothing is staged; review, then: git add -- ${written.map(quote).join(' ')}`)
  }
  if (plan.writes.some((item) => item.identitySweep && written.includes(item.path))) {
    rows.push(
      'identity-only hunks were taken from upstream: run node local/sync/identity-sweep.mjs'
    )
  }
  return rows.join('\n')
}
