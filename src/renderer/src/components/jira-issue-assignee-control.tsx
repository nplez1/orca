import { useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { JiraUserPicker, splitJiraUserPickerOptions } from '@/components/jira-user-picker'
import { getJiraSelfUser } from '@/components/jira-self-user'
import { useJiraSourceConnection } from '@/components/new-workspace/use-jira-source-connection'
import { useAppStore } from '@/store'
import { compareBaseSensitivityLocaleText } from '@/lib/locale-text-collators'
import { jiraListAssignableUsersForTarget } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { JiraIssue, JiraIssueUpdate, JiraUser } from '../../../shared/jira-types'

/**
 * Why one order for both groups: upstream sorts candidate rows by name, and the fork's pinned
 * group is a prefix of that same list rather than a separately-ordered one.
 */
function byJiraDisplayName(a: JiraUser, b: JiraUser): number {
  return (
    compareBaseSensitivityLocaleText(a.displayName, b.displayName) ||
    a.accountId.localeCompare(b.accountId)
  )
}

/**
 * Assignee control for an open Jira issue. Typing narrows the list to the people
 * assignable to this issue, and the current user plus the project's roster stay
 * pinned above the results.
 */
export function JiraIssueAssigneeControl({
  issue,
  disabled,
  sourceContext,
  owner,
  runtimeContextKey,
  mutateIssue
}: {
  issue: JiraIssue
  disabled: boolean
  sourceContext?: TaskSourceContext | null
  owner: RuntimeClientTarget
  runtimeContextKey: string
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<unknown>
}): React.JSX.Element {
  const defaultStatus = useAppStore((state) => state.jiraStatus)
  const defaultStatusKey = useAppStore((state) => state.jiraStatusContextKey)
  const connection = useJiraSourceConnection({
    enabled: true,
    sourceContext: sourceContext ?? null
  })
  const status = sourceContext
    ? connection.status
    : defaultStatusKey === runtimeContextKey
      ? defaultStatus
      : null
  const self = getJiraSelfUser(status, issue.siteId)
  // Why refs: `searchUsers` must be referentially stable or the picker restarts its
  // debounced lookup on every render, and the viewer object is rebuilt each render.
  const selfRef = useRef<JiraUser | null>(null)
  selfRef.current = self
  const selfAccountId = self?.accountId
  // Why the roster is remembered: the picker's first lookup runs with an empty query and
  // its result IS the project roster, so later queries can keep me and my team pinned
  // above the matches without a second request.
  const rosterRef = useRef<JiraUser[]>([])
  const searchUsers = useCallback(
    async (query: string): Promise<JiraUser[]> => {
      const found = await jiraListAssignableUsersForTarget(owner, issue.key, query, issue.siteId)
      if (query.trim().length === 0) {
        rosterRef.current = found
      }
      const me = selfRef.current
      const roster = [...rosterRef.current].sort(byJiraDisplayName)
      const { pinned, rest } = splitJiraUserPickerOptions({
        candidates: found,
        pinned: me ? [me, ...roster] : roster,
        query
      })
      return [...pinned, ...[...rest].sort(byJiraDisplayName)]
    },
    [issue.key, issue.siteId, owner]
  )
  const assign = (user: JiraUser | null): void => {
    if (disabled) {
      return
    }
    void mutateIssue(
      'assignee',
      { assigneeAccountId: user?.accountId ?? null },
      { assignee: user ?? undefined }
    )
  }
  const sourceKey = sourceContext ? getTaskSourceCacheScope(sourceContext) : runtimeContextKey
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="w-40">
        <JiraUserPicker
          key={JSON.stringify([sourceKey, issue.siteId, issue.key])}
          providerSettings={owner}
          siteId={issue.siteId}
          value={
            issue.assignee?.accountId ??
            translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')
          }
          selectedUser={issue.assignee ?? null}
          onSelect={assign}
          disabled={disabled}
          label={translate('components.jiraIssueAssigneeField.label', 'Assignee')}
          fixedOptions={[
            {
              key: 'unassigned',
              label: translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned'),
              onSelect: () => assign(null)
            }
          ]}
          searchUsers={searchUsers}
        />
      </div>
      {self && issue.assignee?.accountId !== selfAccountId ? (
        <Button variant="ghost" size="xs" disabled={disabled} onClick={() => assign(self)}>
          {translate('components.jiraIssueAssigneeField.assignToMe', 'Assign to me ({{name}})', {
            name: self.displayName
          })}
        </Button>
      ) : null}
    </div>
  )
}
