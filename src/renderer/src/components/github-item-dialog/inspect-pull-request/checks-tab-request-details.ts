import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import { loadCheckDetailsWithProviderFallback } from '@/runtime/jenkins-check-details-client'
import { createRuntimeRpcAbortError } from '@/runtime/abortable-runtime-environment-call'
import { normalizeCheckRunDetailsLogTails } from '@/lib/check-run-details-log-normalization'
import {
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE,
  isGitHubCheckDetailsTimeout
} from '../../../../../shared/github/check-details-deadline'
import {
  beginGitHubChecksTabDetails,
  settleGitHubChecksTabDetails,
  type CheckDetailsLoadState
} from '@/components/github-checks-tab-state'
import {
  checkDetailsRowState,
  readCachedCheckDetails,
  rememberCheckDetails
} from '@/components/github/check-details-cache'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'
import type { ChecksTabActionContext } from './checks-tab-actions'

export function requestGitHubCheckDetails(
  ctx: ChecksTabActionContext,
  check: PRCheckDetail,
  key: string
): void {
  if (!ctx.canUseChecksRepoContext || (!check.checkRunId && !check.workflowRunId && !check.url)) {
    return
  }
  const requestId = ++ctx.nextCheckDetailsRequestIdRef.current
  const readFor = checkDetailsRowState(check)
  // Why: a refresh renders the payload it already has, so a failed one must not blank it.
  const commit = (next: Omit<CheckDetailsLoadState, 'requestId'>, keepShown: boolean): void => {
    if (!ctx.mountedRef.current) {
      return
    }
    ctx.setChecksState((current) =>
      settleGitHubChecksTabDetails(current, key, requestId, {
        ...next,
        details: keepShown
          ? (next.details ?? current.detailsByCheckKey[key]?.details ?? null)
          : next.details
      })
    )
  }
  ctx.setChecksState((current) =>
    beginGitHubChecksTabDetails(current, key, requestId, readCachedCheckDetails(check))
  )
  const detailsRequest = loadCheckDetailsWithProviderFallback(check, () =>
    withGitHubCheckDetailsTimeout((signal) =>
      ctx.runtimeHost
        ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.prCheckDetails>>>(
            { kind: 'environment', environmentId: ctx.runtimeHost.environmentId },
            'github.prCheckDetails',
            {
              repo: getGitHubRuntimeRepoId(ctx.sourceContext, ctx.repoId ?? ctx.itemRepoId),
              checkRunId: check.checkRunId,
              workflowRunId: check.workflowRunId,
              checkName: check.name,
              url: check.url,
              prRepo: ctx.prRepo
            },
            { timeoutMs: 30_000, signal }
          )
        : window.api.gh.prCheckDetails({
            repoPath: ctx.repoPath ?? '',
            repoId: ctx.repoId ?? undefined,
            sourceContext: ctx.sourceContext,
            checkRunId: check.checkRunId,
            workflowRunId: check.workflowRunId,
            checkName: check.name,
            url: check.url,
            prRepo: ctx.prRepo
          })
    )
  )
  void detailsRequest
    .then((rawDetails) => {
      const details = normalizeCheckRunDetailsLogTails(rawDetails)
      const readAt = Date.now()
      if (details) {
        rememberCheckDetails(check, { data: details, fetchedAt: readAt, readFor })
      }
      commit(
        {
          loading: false,
          details,
          error: details
            ? null
            : translate(
                'auto.components.GitHubItemDialog.e15a8b77ef',
                'No inline details are available for this check.'
              ),
          readAt,
          readFor
        },
        false
      )
    })
    .catch((err) => {
      const timeoutMessage = translate(
        'auto.runtime.githubCheckDetailsTimeout.timedOut',
        GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
      )
      const isTimeout =
        isGitHubCheckDetailsTimeout(err) || (err instanceof Error && err.message === timeoutMessage)
      commit(
        {
          loading: false,
          details: null,
          error: isTimeout
            ? timeoutMessage
            : err instanceof Error && err.name === 'AbortError'
              ? createRuntimeRpcAbortError().message
              : translate(
                  'auto.components.GitHubItemDialog.e45324fbed',
                  'Failed to load check details.'
                ),
          readAt: Date.now(),
          readFor
        },
        true
      )
    })
}
