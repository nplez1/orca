/**
 * Wire contract for relocating a repo's primary checkout into its project folder.
 *
 * Flat on purpose: the client reports and explains a decision, so a refusal has to survive the wire
 * as a value rather than an error, and the server's internal plan/outcome unions stay server-side.
 */

/** Why the repo is (or is not) a candidate. `ready` is the only one that permits a move. */
export type RepoRelocationDecision =
  | 'ready'
  | 'not-project-folder-layout'
  | 'already-in-container'
  | 'remote-host'
  | 'windows'
  | 'not-a-git-repo'
  | 'unknown-default-branch'

/** What happened when a move was attempted. Absent on a dry run. */
export type RepoRelocationOutcome = 'relocated' | 'live-sessions' | 'target-exists' | 'cross-volume'

export type RuntimeRepoRelocationResult = {
  repoId: string
  decision: RepoRelocationDecision
  /** The move this decision describes. Present only when the decision is `ready`. */
  plan?: {
    containerPath: string
    targetPath: string
    defaultBranchName: string
  }
  /** Absent on a dry run, and on every decision that is not `ready`. */
  outcome?: {
    kind: RepoRelocationOutcome
    /** The checkout's previous path; present only when it actually moved. */
    from?: string
    /** The checkout's new path; present only when it actually moved. */
    to?: string
  }
}
