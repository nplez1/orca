import { useCallback, useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  JiraUserOptionList,
  splitJiraUserPickerOptions,
  useJiraUserSearch
} from '@/components/jira-user-picker'
import { jiraListAssignableUsers } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { JiraIssue, JiraIssueUpdate, JiraUser } from '../../../shared/jira-types'

/**
 * Assignee control for an open Jira issue. Typing narrows the list to the people
 * assignable to this issue, and the current user plus the project's roster stay
 * pinned above the results.
 */
export function JiraIssueAssigneeControl({
  displayed,
  users,
  selfUser,
  providerSettings,
  pending,
  mutateIssue
}: {
  displayed: JiraIssue
  /** The issue's assignable users — the project roster, which is the pinned group. */
  users: JiraUser[]
  selfUser: JiraUser | null
  providerSettings: RuntimeJiraSettings
  pending: boolean
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>
  ) => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Why strings and not `displayed`: a refresh swaps the issue object, and an unstable
  // search callback would restart the search under the user's cursor.
  const issueKey = displayed.key
  const siteId = displayed.siteId
  const searchUsers = useCallback(
    (value: string) => jiraListAssignableUsers(providerSettings, issueKey, value, siteId),
    [issueKey, providerSettings, siteId]
  )
  const hasQuery = query.trim().length > 0
  const { users: found, loading } = useJiraUserSearch({
    // Why: the roster is already loaded as `users`, so only a typed query needs a request.
    active: open && hasQuery,
    query,
    searchUsers
  })
  // Why gated on the query: clearing it abandons its lookup mid-flight, leaving `loading` set.
  const searching = hasQuery && loading
  const options = useMemo(
    () =>
      splitJiraUserPickerOptions({
        candidates: hasQuery ? found : [],
        pinned: selfUser ? [selfUser, ...users] : users,
        query
      }),
    [found, hasQuery, query, selfUser, users]
  )

  const selectAssignee = useCallback(
    (user: JiraUser) => {
      void mutateIssue('assignee', { assigneeAccountId: user.accountId }, { assignee: user })
      setOpen(false)
    },
    [mutateIssue]
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pending}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
        >
          {displayed.assignee?.displayName ??
            translate('auto.components.JiraIssueWorkspace.54649eaeab', '+ Assignee')}
          {pending ? <LoaderCircle className="size-3 animate-spin" /> : null}
        </button>
      </PopoverTrigger>
      {/* Why the wrapper: `popover-scroll-content` carries the height and scroll styling, and
          `wheelScroll` keeps the Radix scroll-lock from swallowing the wheel inside it. */}
      <PopoverContent className="w-56" align="start" wheelScroll>
        <div className="popover-scroll-content scrollbar-sleek p-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('components.jiraUserPicker.search', 'Search users')}
            className="mb-1 h-7"
            autoFocus
          />
          <button
            type="button"
            onClick={() => {
              void mutateIssue('assignee', { assigneeAccountId: null }, { assignee: undefined })
              setOpen(false)
            }}
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
          >
            {translate('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
          </button>
          {searching ? (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              {translate('auto.components.right.sidebar.IssueAssignee.searching', 'Searching…')}
            </div>
          ) : null}
          <JiraUserOptionList users={options.pinned} onSelect={selectAssignee} />
          {options.pinned.length > 0 && options.rest.length > 0 ? (
            <div className="my-1 h-px bg-border/60" aria-hidden />
          ) : null}
          <JiraUserOptionList users={options.rest} onSelect={selectAssignee} />
          {!searching && options.pinned.length === 0 && options.rest.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
              {translate('components.jiraUserPicker.empty', 'No users found')}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
