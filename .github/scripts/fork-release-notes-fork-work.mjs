// Which commits in a release range are this fork's own work, so the notes can lead with them.
//
// Why authorship rather than subject text: a sync rebases this fork onto upstream, which rewrites shas
// and preserves authors, so the author is the one field that still says who wrote a change after any
// number of replays. `local(...)` cannot answer it — that series is sync and release bookkeeping, not
// product work — and a subject cannot, because a fork PR and an upstream PR are shaped alike.
//
// Why a list in the file: it is this fork's own script, and the same two identities author every fork
// commit (`nplez1`, and the automation account the fork's own PRs merge as).

const FORK_AUTHOR_EMAILS = new Set(['nplez1@gmail.com'])
const FORK_AUTHOR_NAMES = new Set(['nplez1', 'Nathan Plesnicher', 'lab-agent-np[bot]'])

/** True when this commit was written in this fork rather than inherited from upstream. */
export function isForkCommit(commit) {
  return (
    FORK_AUTHOR_EMAILS.has(String(commit.email ?? '').toLowerCase()) ||
    FORK_AUTHOR_NAMES.has(String(commit.author ?? ''))
  )
}

/** The entries this fork wrote, then the ones it inherited, from one group's entries. */
export function splitEntriesByFork(entries) {
  return {
    fork: entries.filter((entry) => entry.fork === true),
    inherited: entries.filter((entry) => entry.fork !== true)
  }
}

/** A group whose entries bookkeep the repository: the `local(...)` series and maintenance tail. */
export function isBookkeepingGroup(group) {
  return group === 'local' || group === 'chore'
}

/** Fork and inherited commit counts over the product changes, leaving bookkeeping out of both. */
export function countStreams(commits, classify) {
  const product = commits.filter((commit) => !isBookkeepingGroup(classify(commit.subject).group))
  const forkCount = product.filter(isForkCommit).length
  return { forkCount, inheritedCount: product.length - forkCount }
}

/** Whether the product changes in a range are the fork's own, and how they split. */
export const forkClause = (forkCount, inherited) =>
  forkCount === 0
    ? inherited === 0
      ? 'no product change in this range'
      : 'all of them inherited from upstream'
    : inherited === 0
      ? `**all ${forkCount} product changes are this fork’s own**, listed first under an "in this fork" heading`
      : `**${forkCount} of them this fork’s own**, the other ${inherited} inherited from upstream`

/** A group's heading for the fork's own changes, so the reader cannot mistake them for upstream's. */
export function forkGroupTitle(title) {
  return `${title} in this fork`
}
