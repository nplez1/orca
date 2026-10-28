import React from 'react'
import { LoaderCircle, PanelRight, RefreshCw, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { JENKINS_INTEGRATION_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { useAppStore } from '@/store'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckJob } from '../../../../../shared/github/check-types'
import { paneCheckSteps } from '../../../../../shared/check-step-visibility'
import type { GitHubRepositoryIdentity } from '../../../../../shared/github/pull-request-types'
import { CheckJobLogTail } from '../check-job-log-tail'
import { CheckStepOutcomeIcon } from '@/components/check-step-outcome-icon'
import { resolveStepOutcome } from '@/components/editor/check-job-step-status'
import { translate } from '@/i18n/i18n'
import { useDelayedFlag } from '@/hooks/use-delayed-flag'
import { checkJobIdentities } from '@/components/editor/check-details-reading-cache'
import {
  type CheckDetailsLoadState,
  type CheckDetailsStickySurface,
  formatCheckTimestamp,
  getCheckConclusion,
  getCheckDetailsStickySurfaceClass,
  getCheckDurationMs,
  getCheckStatusLabel
} from './check-details-model'
import { CheckBuildMetadata, formatBuildDuration } from '@/components/check-build-metadata'
import { JenkinsRebuildButton } from '@/components/jenkins-rebuild-button'

function ViewFullCheckDetailsButton({
  onClick,
  label
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  label: string
}): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="xs" className="shrink-0" onClick={onClick}>
      <PanelRight className="size-3" />
      {label}
    </Button>
  )
}

/**
 * One job's steps or CI stages.
 *
 * GitHub Actions keeps its compact failures-only list here; a stage list (Jenkins) is reduced to
 * the stages still moving and the ones that failed, capped, because a pipeline can list hundreds.
 */
function CheckJobSteps({ job }: { job: PRCheckJob }): React.JSX.Element | null {
  const { steps, hiddenCount } = paneCheckSteps(job)
  if (steps.length === 0 && hiddenCount === 0) {
    return null
  }
  return (
    <div className="mt-1 grid gap-0.5 pl-2">
      {steps.map((step) => (
        <div
          // Why the id: a Jenkins stage list can repeat a stage name in a loop, and duplicate
          // React keys would make it drop or duplicate rows.
          key={step.id ?? `${step.name}:${step.startedAt ?? ''}`}
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <CheckStepOutcomeIcon outcome={resolveStepOutcome(step)} />
          <span className="min-w-0 flex-1 truncate">{step.name}</span>
          <span className="shrink-0">{step.conclusion ?? step.status}</span>
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {translate('checkDetails.hiddenStages', '+{{value0}} more stages', {
            value0: hiddenCount
          })}
        </div>
      )}
    </div>
  )
}

export function CheckRunDetails({
  check,
  state,
  checkDetailsContextKey,
  worktreeId,
  detailsStickySurface = 'sidebar',
  getGitLabProjectRef,
  githubRepository,
  onRetry
}: {
  check: PRCheckDetail
  state: CheckDetailsLoadState | undefined
  checkDetailsContextKey: string
  worktreeId: string | null
  detailsStickySurface?: CheckDetailsStickySurface
  /** Why: a getter, not a value — the source ref is filled by an async fetch and would read stale during render. */
  getGitLabProjectRef?: () => GitLabProjectRef | null
  githubRepository?: GitHubRepositoryIdentity | null
  onRetry: () => void
}): React.JSX.Element {
  const openCheckRunDetails = useAppStore((s) => s.openCheckRunDetails)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const details = state?.details
  const startedAt = formatCheckTimestamp(details?.startedAt)
  const completedAt = formatCheckTimestamp(details?.completedAt)
  const durationMs = getCheckDurationMs(details?.startedAt, details?.completedAt)
  const detailsStatusCheck: PRCheckDetail = {
    ...check,
    status: (details?.status as PRCheckDetail['status'] | undefined) ?? check.status,
    conclusion: (details?.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
  }
  const entries = checkJobIdentities(details?.jobs ?? [])
  const failedEntries = entries.filter(({ job }) => resolveStepOutcome(job) === 'failure')
  const jobs = failedEntries.length > 0 ? failedEntries : entries
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = jobs.length > 0
  const refreshing = useDelayedFlag(Boolean(state?.loading && details))
  const fullDetailsLabel = translate(
    'auto.components.right.sidebar.checks.panel.content.e4e3af15ee',
    'View full details'
  )

  const openFullDetailsTab = (): void => {
    if (!worktreeId) {
      return
    }
    openCheckRunDetails(worktreeId, checkDetailsContextKey, check, {
      requestId: state?.requestId,
      details: state?.details ?? null,
      loading: state?.loading ?? false,
      error: state?.error ?? null,
      errorAction: state?.errorAction ?? null,
      githubRepository: githubRepository ?? null,
      gitlabProjectRef: getGitLabProjectRef?.() ?? null
    })
  }

  const handleOpenFullDetails = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    openFullDetailsTab()
  }

  return (
    <div className="mb-1 ml-[26px] mr-3 min-w-0 border-l border-border pl-3">
      {worktreeId && (
        // Why: inline check details can be long; pinning the affordance keeps it
        // visible while scrolling through annotations and job output.
        <div
          className={cn(
            'sticky top-0 z-10 -ml-3 flex min-w-0 items-center gap-2 border-b border-border/60 py-1 pl-3 backdrop-blur-sm',
            getCheckDetailsStickySurfaceClass(detailsStickySurface)
          )}
        >
          <span className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground">
            {check.name}
          </span>
          <ViewFullCheckDetailsButton label={fullDetailsLabel} onClick={handleOpenFullDetails} />
        </div>
      )}
      {state?.loading && !details && !state.error ? (
        <div role="status" aria-live="polite" className="flex min-w-0 flex-col gap-2 py-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {translate(
              'auto.components.right.sidebar.checks.panel.content.1f2b980522',
              'Loading check details…'
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5 py-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            <span>
              {translate(
                'auto.components.right.sidebar.checks.panel.content.a54ae21c6f',
                'Status:'
              )}{' '}
              {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
            </span>
            {startedAt && (
              <span>
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.fd46a70f1a',
                  'Started'
                )}{' '}
                {startedAt}
              </span>
            )}
            {completedAt && (
              <span>
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.00e1c1658a',
                  'Completed'
                )}{' '}
                {completedAt}
              </span>
            )}
            {durationMs !== null && (
              <span>
                {translate('checkDetails.duration', 'Duration')} {formatBuildDuration(durationMs)}
              </span>
            )}
            {check.checkRunId && (
              <span className="font-mono">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.aa8494ae3c',
                  'check #'
                )}
                {check.checkRunId}
              </span>
            )}
            {check.workflowRunId && (
              <span className="font-mono">
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.2dd5ddabc4',
                  'workflow #'
                )}
                {check.workflowRunId}
              </span>
            )}
            {refreshing && (
              <span role="status" aria-live="polite" className="flex items-center gap-1">
                <LoaderCircle className="size-3 animate-spin" />
                {translate('githubChecks.refreshingDetails', 'Refreshing check details…')}
              </span>
            )}
            {/* Why no onStarted: this panel polls, so the row picks the new build up on its own. */}
            <JenkinsRebuildButton check={check} className="ml-auto" />
          </div>

          {state?.error && (
            <div role="alert" className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 break-words text-xs text-destructive">
                {state.error}
              </span>
              <div className="flex items-center gap-1.5">
                {state.errorAction?.kind === 'open-jenkins-settings' && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() =>
                      openSettingsTarget({
                        pane: 'integrations',
                        repoId: null,
                        sectionId: JENKINS_INTEGRATION_SETTINGS_TARGET_ID
                      })
                    }
                  >
                    <Settings className="size-3" />
                    {translate('checkDetails.openJenkinsSettings', 'Open Jenkins settings')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  disabled={state.loading}
                  aria-busy={state.loading}
                  onClick={onRetry}
                >
                  <RefreshCw className={cn('size-3', state.loading && 'animate-spin')} />
                  {state.loading
                    ? translate('githubChecks.retrying', 'Retrying…')
                    : translate(
                        'auto.components.right.sidebar.checks.panel.content.dcb3c546fe',
                        'Retry'
                      )}
                </Button>
              </div>
            </div>
          )}

          {(resolveStepOutcome(details ?? check) === 'failure'
            ? ['jobs', 'output', 'annotations']
            : ['output', 'annotations', 'jobs']
          ).map((section) => {
            if (section === 'jobs') {
              return hasJobs ? (
                <div key="jobs" className="min-w-0 border-t border-border/60 pt-2">
                  <div className="mb-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {failedEntries.length > 0
                      ? translate(
                          'auto.components.right.sidebar.checks.panel.content.066fedd446',
                          'Failed jobs'
                        )
                      : translate(
                          'auto.components.right.sidebar.checks.panel.content.49731703ea',
                          'Jobs'
                        )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {jobs.map(({ job, identity }) => (
                      <div key={identity} className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                            {job.name}
                          </span>
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            {job.conclusion ??
                              job.status ??
                              translate(
                                'auto.components.right.sidebar.checks.panel.content.ee07b33924',
                                'unknown'
                              )}
                          </span>
                        </div>
                        <CheckJobSteps job={job} />
                        <CheckJobLogTail job={job} surface="sidebar" jobIdentity={identity} />
                      </div>
                    ))}
                  </div>
                  {(details?.jobs.length ?? 0) >= 100 && (
                    <div className="mt-1.5 text-3xs text-muted-foreground">
                      {translate(
                        'auto.components.right.sidebar.checks.panel.content.a2fb3f4408',
                        'Showing first 100 jobs'
                      )}
                    </div>
                  )}
                </div>
              ) : null
            }
            if (section === 'annotations') {
              return hasAnnotations ? (
                <div key="annotations" className="min-w-0 border-t border-border/60 pt-2">
                  <div className="mb-1.5 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {translate(
                      'auto.components.right.sidebar.checks.panel.content.f2fe8a4e8f',
                      'Annotations'
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    {details!.annotations.map((annotation, index) => (
                      <div key={`${annotation.path ?? 'annotation'}-${index}`} className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                            {annotation.path ??
                              translate(
                                'auto.components.right.sidebar.checks.panel.content.cdbfda4dec',
                                'Annotation'
                              )}
                            {annotation.startLine ? `:${annotation.startLine}` : ''}
                          </span>
                          {annotation.annotationLevel && (
                            <span className="shrink-0 text-2xs text-muted-foreground">
                              {annotation.annotationLevel}
                            </span>
                          )}
                        </div>
                        {annotation.title && (
                          <div className="mt-0.5 text-xs font-medium text-foreground">
                            {annotation.title}
                          </div>
                        )}
                        <div className="mt-0.5 break-words text-xs text-foreground">
                          {annotation.message}
                        </div>
                        {annotation.rawDetails && (
                          <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-2xs text-muted-foreground">
                            {annotation.rawDetails}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                  {details!.annotations.length >= 20 && (
                    <div className="mt-1.5 text-3xs text-muted-foreground">
                      {translate(
                        'auto.components.right.sidebar.checks.panel.content.df137989b3',
                        'Showing first 20 annotations'
                      )}
                    </div>
                  )}
                </div>
              ) : null
            }
            return hasOutput ? (
              <div key="output" className="min-w-0">
                {details?.title && (
                  <div className="mb-1 text-xs font-medium text-foreground">{details.title}</div>
                )}
                {details?.summary && (
                  <CommentMarkdown
                    content={details.summary}
                    variant="document"
                    className="min-w-0 max-w-full overflow-hidden break-words text-xs leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
                {details?.text && (
                  <CommentMarkdown
                    content={details.text}
                    variant="document"
                    className="mt-2 min-w-0 max-w-full overflow-hidden break-words text-xs leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                  />
                )}
              </div>
            ) : null
          })}

          <CheckBuildMetadata build={details?.build} className="border-t border-border/60 pt-2" />

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-xs text-muted-foreground">
              {getCheckConclusion(detailsStatusCheck) === 'action_required'
                ? translate(
                    'auto.components.right.sidebar.checks.panel.content.actionRequiredHint',
                    'Needs a manual action on GitHub (e.g. approving the run) to unblock merging.'
                  )
                : translate(
                    'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                    'No inline details are available for this check.'
                  )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
