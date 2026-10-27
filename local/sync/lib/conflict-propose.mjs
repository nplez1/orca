/**
 * Turn a conflicted path into an action, but only when the fork has already decided it twice over: the
 * ledger records a `Resolution:` verb, or the deletion manifest records the path as settled. Everything
 * else is deliberately `null`, because a resolver that guesses is worse than one that asks.
 *
 * A verb is a **whole-file** decision. Where the decision is hunk-level — the Identity entry keeps its
 * literal but takes upstream's surroundings — the ledger says `manual` and this returns nothing, because
 * applying `keep-ours` there would revert upstream's work wholesale.
 *
 * Pure: takes a file already annotated by `conflicts.mjs` (`class`, `ledger`, `expectedDeletion`) and
 * returns a proposal, never a command result.
 */
const SETTLED_DELETION_STATUSES = ['expected-deletion', 'restore']

const CHECKOUT = {
  'keep-ours': { side: 'ours', action: 'keep-ours' },
  'take-theirs': { side: 'theirs', action: 'take-theirs' }
}

export function proposeResolution(file) {
  const isModifyDelete = String(file.class ?? '').includes('modify/delete')
  const deletion = file.expectedDeletion ?? null

  // A modify/delete conflict is decided by the manifest when it is settled, and a manifest entry that
  // says "restore" outranks the ledger: it was written later, about this exact question.
  if (isModifyDelete && deletion && SETTLED_DELETION_STATUSES.includes(deletion.status)) {
    const restore = deletion.status === 'restore'
    return {
      path: file.path,
      action: restore ? 'take-theirs' : 'delete',
      provenance: `expected-deletions.json (${deletion.commit ?? 'no commit'})`,
      reason: deletion.reason ?? '',
      git: restore
        ? [
            ['checkout', '--theirs', '--', file.path],
            ['add', '--', file.path]
          ]
        : [['rm', '-f', '--', file.path]]
    }
  }

  const decided = (file.ledger ?? []).find(
    (entry) => entry.resolution && entry.resolution.action !== 'unknown'
  )
  if (!decided) {
    return null
  }
  const { action, note } = decided.resolution
  const provenance = `convergence-ledger.md: ${decided.title}`
  if (action === 'delete') {
    return {
      path: file.path,
      action,
      provenance,
      reason: note,
      git: [['rm', '-f', '--', file.path]]
    }
  }
  if (CHECKOUT[action]) {
    return {
      path: file.path,
      action: CHECKOUT[action].action,
      provenance,
      reason: note,
      git: [
        ['checkout', `--${CHECKOUT[action].side}`, '--', file.path],
        ['add', '--', file.path]
      ]
    }
  }
  // `manual` and `rerere` are decisions about HOW to resolve, not answers to apply.
  return null
}

export function proposeAll(files) {
  return files.map((file) => proposeResolution(file)).filter(Boolean)
}

/** A proposal is only safe to apply when every step names an existing index stage or a tracked path. */
export function applyableProposals(proposals) {
  return proposals.filter((proposal) => Array.isArray(proposal.git) && proposal.git.length > 0)
}
