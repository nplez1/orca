import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import type { IssueLinkProvider } from '../../../../shared/issue-link-input'
import type { Worktree } from '../../../../shared/worktree/types'
import { getOfferedIssueLinkProviders } from './issue-link-provider-options'
import { useResolveWorktreeMetaJiraLink } from './use-worktree-meta-jira-link'

/** What the workspace issue row needs beyond the field's own value: which
 *  providers it may offer, and how to open the issue a typed value names. */
export function useIssueLinkRowOptions(args: {
  worktree: Pick<Worktree, 'hostId' | 'linkedTaskSourceContext'> | undefined
  selected: IssueLinkProvider
}): {
  offeredProviders: IssueLinkProvider[]
  resolveJiraIssueUrl: (parsed: { key: string; siteUrl: string | null }) => Promise<string | null>
} {
  const { worktree, selected } = args
  const linearConnected = useLinearProviderConnected()
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const providerRuntimeContextKey = useAppStore((s) => getProviderRuntimeContextKey(s.settings))
  const resolveJiraIssueLink = useResolveWorktreeMetaJiraLink({ worktree })

  // Why: the context-key guard rejects a status fetched for a different runtime
  // environment, the same rule the Settings nav uses before offering Jira.
  const offeredProviders = useMemo(
    () =>
      getOfferedIssueLinkProviders({
        connected: {
          linear: linearConnected,
          jira:
            jiraStatusChecked &&
            jiraStatusContextKey === providerRuntimeContextKey &&
            jiraStatus.connected === true
        },
        selected
      }),
    [
      jiraStatus.connected,
      jiraStatusChecked,
      jiraStatusContextKey,
      linearConnected,
      providerRuntimeContextKey,
      selected
    ]
  )

  const resolveJiraIssueUrl = useCallback(
    async (parsed: { key: string; siteUrl: string | null }): Promise<string | null> => {
      const resolution = await resolveJiraIssueLink(parsed)
      return resolution.ok ? resolution.link.linkedWorkItem.url : null
    },
    [resolveJiraIssueLink]
  )

  return { offeredProviders, resolveJiraIssueUrl }
}
