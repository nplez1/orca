export type PRCheckDetail = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'timed_out'
    | 'neutral'
    | 'skipped'
    | 'pending'
    // Why: a check suite needing manual action (e.g. a workflow awaiting "Approve
    // and run") has no check run and is absent from statusCheckRollup, yet blocks
    // auto-merge (GitHub returns "unstable status"). Surface it as its own state.
    | 'action_required'
    | null
  url: string | null
  checkRunId?: number
  workflowRunId?: number
  // Why: the GitLab job trace API is addressed by numeric job id only, so the
  // Checks panel cannot load a job log without carrying it on the row.
  gitlabJobId?: number
}

export type PRCheckAnnotation = {
  path: string | null
  startLine: number | null
  endLine: number | null
  annotationLevel: string | null
  title: string | null
  message: string
  rawDetails: string | null
}

export type PRCheckStep = {
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
}

export type PRCheckJob = {
  id: number | null
  name: string
  status: string | null
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  url: string | null
  logTail: string | null
  steps: PRCheckStep[]
  /**
   * Which steps a details surface should list.
   *
   * GitHub Actions emits a long step list where only the failures are worth reading, while a CI
   * stage list (Jenkins) is short and every stage answers "where is this stuck?" — including the
   * one still running. Defaults to `failures-only` so existing providers keep their compact list.
   */
  stepRendering?: 'failures-only' | 'all'
}

export type PRCheckBuildParameter = {
  name: string
  /** Rendered value. Secret parameter values are masked by the provider client before they arrive. */
  value: string
  secret: boolean
}

export type PRCheckBuildCommit = {
  id: string
  message: string | null
  author: string | null
}

/**
 * Build-level facts a CI provider reports that have no home in the GitHub-shaped fields above.
 *
 * Why structured rather than prose: `title`/`summary`/`text` are written and localized by the
 * provider, but these are assembled by Orca, so they have to reach the renderer as data and go
 * out through `translate()`.
 */
export type PRCheckBuild = {
  /** Build identifier as the provider displays it (`1234`), or null when the link named no build. */
  number: string | null
  /** Milliseconds spent queued before starting, when the provider reports it separately. */
  queuedMs: number | null
  estimatedDurationMs: number | null
  /** Provider-authored phrase for what started the build. */
  triggeredBy: string | null
  parameters: PRCheckBuildParameter[]
  /** Commits the build ran against, newest first. Bounded by the provider client. */
  commits: PRCheckBuildCommit[]
}

export type PRCheckRunDetails = {
  name: string
  status: PRCheckDetail['status'] | (string & {}) | null
  conclusion: PRCheckDetail['conclusion'] | (string & {}) | null
  url: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  title: string | null
  summary: string | null
  text: string | null
  annotations: PRCheckAnnotation[]
  jobs: PRCheckJob[]
  build?: PRCheckBuild
}

export type GitHubRerunPRChecksResult = { ok: true; count: number } | { ok: false; error: string }
