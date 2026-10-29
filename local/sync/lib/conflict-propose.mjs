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

// `keep-ours` / `take-theirs` are the LEDGER's words, which are about the fork and upstream, not about
// git's stages. On a merge the fork is `ours`; a rebase replays the fork onto upstream, so the stages
// invert and the same verb would check out the opposite side. `stage()` is the only place that mapping
// lives.
const CHECKOUT = {
  'keep-ours': { owner: 'fork', action: 'keep-ours' },
  'take-theirs': { owner: 'upstream', action: 'take-theirs' }
}

const stage = (owner, rebase) =>
  owner === 'fork' ? (rebase ? 'theirs' : 'ours') : rebase ? 'ours' : 'theirs'

// `DU` is deleted by us: on a merge the fork is the "ours" side, so it is the one that removed the file.
// A REBASE inverts the sides — "ours" is the upstream commit being replayed onto and "theirs" is the
// fork's — so the same code means the opposite there. `DD` is both-deleted, which classifies as
// `both-deleted` and is refused before this is reached.
const DELETED_BY_OURS = new Set(['DU'])
const DELETED_BY_THEIRS = new Set(['UD'])

const sameLines = (left, right) =>
  left.length === right.length && left.every((line, index) => line === right[index])

/**
 * Whether the fork has a hunk of its own in this file; `null` when that cannot be decided.
 *
 * A hunk with no base section cannot answer it — `classifyHunk` records an empty `base` rather than null
 * when `|||||||` is missing, and comparing against an empty base reads any hunk as fork-owned — so the
 * absence is reported as unknown and the caller refuses rather than guesses.
 */
export function forkHasOwnHunks(file) {
  if (!Array.isArray(file.hunks) || file.hunks.length === 0) {
    return null
  }
  if (file.hunks.some((hunk) => hunk.basePresent === false || hunk.base === null)) {
    return null
  }
  return file.hunks.some((hunk) => !sameLines(hunk.ours ?? [], hunk.base ?? []))
}

/** Whether the fork's side is the one that deleted the path; `null` when the status is not known. */
export function forkDeleted(file, { rebase = false } = {}) {
  if (typeof file.status === 'string') {
    return (rebase ? DELETED_BY_THEIRS : DELETED_BY_OURS).has(file.status)
  }
  if (file.sides) {
    return rebase ? file.sides.theirs === false : file.sides.ours === false
  }
  return null
}

export function proposeResolution(file, { rebase = false } = {}) {
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
    if (!restore && forkDeleted(file, { rebase }) !== true) {
      return null
    }
    return {
      path: file.path,
      action: restore ? 'take-theirs' : 'delete',
      provenance: `expected-deletions.json (${deletion.commit ?? 'no commit'})`,
      reason: deletion.reason ?? '',
      git: restore
        ? [
            ['checkout', `--${stage('upstream', rebase)}`, '--', file.path],
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
    if (!isModifyDelete || forkDeleted(file, { rebase }) !== true) {
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
        ['checkout', `--${stage(CHECKOUT[action].owner, rebase)}`, '--', file.path],
        ['add', '--', file.path]
      ]
    }
  }
  // `manual` and `rerere` are decisions about HOW to resolve, not answers to apply.
  return null
}

export function proposeAll(files, options = {}) {
  return files.map((file) => proposeResolution(file, options)).filter(Boolean)
}

/** A proposal is only safe to apply when every step names an existing index stage or a tracked path. */
export function applyableProposals(proposals) {
  return proposals.filter((proposal) => Array.isArray(proposal.git) && proposal.git.length > 0)
}
