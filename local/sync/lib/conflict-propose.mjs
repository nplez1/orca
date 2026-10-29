/**
 * Turn a conflicted path into an action, but only when the fork has already decided it twice over: the
 * ledger records a `Resolution:` verb, or the deletion manifest records the path as settled. Everything
 * else is deliberately `null`, because a resolver that guesses is worse than one that asks.
 *
 * A verb is a **whole-file** decision. Where the decision is hunk-level — the Identity entry keeps its
 * literal but takes upstream's surroundings — the ledger says `manual` and this returns nothing, because
 * applying `keep-ours` there would revert upstream's work wholesale.
 *
 * A whole-file verb is still only safe where it cannot throw work away:
 *   - `pending-decision` silences nothing, for the manifest *or* for a ledger verb it would fall through to;
 *   - `delete` needs a modify/delete the FORK resolved by deleting, because `git rm -f` on a file upstream
 *     still owns is the one thing LOCAL-PATCHES.md forbids outright;
 *   - `take-theirs` needs the fork to have no own hunk in the file, or it discards the fork's changes.
 *
 * Pure: takes a file already annotated by `conflicts.mjs` (`class`, `ledger`, `expectedDeletion`) and
 * returns a proposal, never a command result.
 */
const SETTLED_DELETION_STATUSES = ['expected-deletion', 'restore']

const CHECKOUT = {
  'keep-ours': { side: 'ours', action: 'keep-ours' },
  'take-theirs': { side: 'theirs', action: 'take-theirs' }
}

// `DU` is deleted by us, `DD` both deleted: the fork is the side that removed the file.
const DELETED_BY_FORK = new Set(['DU', 'DD'])

const sameLines = (left, right) =>
  left.length === right.length && left.every((line, index) => line === right[index])

/** Whether the fork has a hunk of its own in this file; `null` when the annotation carries no hunks. */
export function forkHasOwnHunks(file) {
  if (!Array.isArray(file.hunks) || file.hunks.length === 0) {
    return null
  }
  return file.hunks.some(
    (hunk) =>
      hunk.base !== null && hunk.base !== undefined && !sameLines(hunk.ours ?? [], hunk.base)
  )
}

/** Whether the fork's side is the one that deleted the path; `null` when the status is not known. */
export function forkDeleted(file) {
  if (typeof file.status === 'string') {
    return DELETED_BY_FORK.has(file.status)
  }
  return file.sides ? file.sides.ours === false : null
}

export function proposeResolution(file) {
  const isModifyDelete = String(file.class ?? '').includes('modify/delete')
  const deletion = file.expectedDeletion ?? null

  // Nobody has decided this one. It must not fall through to a ledger verb: the verb was written about
  // some other conflict, and `fork-symbols.mjs` promises `pending-decision` silences nothing.
  if (deletion?.status === 'pending-decision') {
    return null
  }

  // A modify/delete conflict is decided by the manifest when it is settled, and a manifest entry that
  // says "restore" outranks the ledger: it was written later, about this exact question.
  if (isModifyDelete && deletion && SETTLED_DELETION_STATUSES.includes(deletion.status)) {
    const restore = deletion.status === 'restore'
    // A manifest that calls a path deleted while the fork still has its file is a manifest to fix, not
    // an answer to apply: deleting it here would throw away a file the fork never removed.
    if (!restore && forkDeleted(file) !== true) {
      return null
    }
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
    if (!isModifyDelete || forkDeleted(file) !== true) {
      return null
    }
    return {
      path: file.path,
      action,
      provenance,
      reason: note,
      git: [['rm', '-f', '--', file.path]]
    }
  }
  if (CHECKOUT[action]) {
    if (action === 'take-theirs' && forkHasOwnHunks(file) !== false) {
      return null
    }
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
