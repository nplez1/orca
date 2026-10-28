import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getGitHubRuntimeRepoId, type GitHubRuntimeHost } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import { rerunChecksAcrossProviders } from '@/components/pr-checks-rerun'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubChecksTabState } from '../../github-checks-tab-state'

/** The checks tab mints one of these per context; only its reference identity is ever read. */
type ChecksContextOwner = GitHubChecksTabState['contextOwner']

export async function rerunPullRequestChecks(args: {
  canUseChecksRepoContext: boolean
  rerunning: boolean
  committedChecksContextOwnerRef: { current: ChecksContextOwner }
  setRerunningOwner: (
    value:
      | ChecksContextOwner
      | null
      | ((current: ChecksContextOwner | null) => ChecksContextOwner | null)
  ) => void
  runtimeHost: GitHubRuntimeHost | null
  sourceContext?: TaskSourceContext | null
  repoId: string | null
  repoPath: string | null
  item: GitHubWorkItem
  headSha: string | undefined
  prRepo: GitHubOwnerRepo | null
  /** The list being rerun, so the Jenkins half of a mixed failure list is not silently skipped. */
  checks: PRCheckDetail[]
  failedOnly: boolean
  mountedRef: { current: boolean }
  handleRefresh: (expectedContextOwner?: ChecksContextOwner) => Promise<PRCheckDetail[] | null>
}): Promise<void> {
  if (!args.canUseChecksRepoContext || args.rerunning) {
    return
  }
  const rerunContextOwner = args.committedChecksContextOwnerRef.current
  args.setRerunningOwner(rerunContextOwner)
  try {
    const outcome = await rerunChecksAcrossProviders({
      checks: args.checks,
      failedOnly: args.failedOnly,
      rerunGitHub: () =>
        args.runtimeHost
          ? callRuntimeRpc<Awaited<ReturnType<typeof window.api.gh.rerunPRChecks>>>(
              { kind: 'environment', environmentId: args.runtimeHost.environmentId },
              'github.rerunPRChecks',
              {
                repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId ?? args.item.repoId),
                prNumber: args.item.number,
                headSha: args.headSha,
                failedOnly: args.failedOnly,
                prRepo: args.prRepo
              },
              { timeoutMs: 30_000 }
            )
          : window.api.gh.rerunPRChecks({
              repoPath: args.repoPath ?? '',
              repoId: args.repoId ?? undefined,
              sourceContext: args.sourceContext,
              prNumber: args.item.number,
              headSha: args.headSha,
              failedOnly: args.failedOnly,
              prRepo: args.prRepo
            })
    })
    if (
      !args.mountedRef.current ||
      args.committedChecksContextOwnerRef.current !== rerunContextOwner
    ) {
      return
    }
    if (!outcome.ok) {
      toast.error(outcome.message)
      // Why still refresh: a partial success means builds did start, and the list is now stale.
      if (outcome.started > 0) {
        await args.handleRefresh(rerunContextOwner)
      }
      return
    }
    toast.success(outcome.message)
    await args.handleRefresh(rerunContextOwner)
  } catch (err) {
    if (
      args.mountedRef.current &&
      args.committedChecksContextOwnerRef.current === rerunContextOwner
    ) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.PullRequestPage.788a782bb0', 'Failed to rerun checks')
      )
    }
  } finally {
    if (args.mountedRef.current) {
      args.setRerunningOwner((current) => (current === rerunContextOwner ? null : current))
    }
  }
}
