import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { jiraSearchUsers, type RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { JiraUser } from '../../../shared/jira/jira-types'

const USER_SEARCH_DEBOUNCE_MS = 250

export function JiraUserOptionList({
  users,
  onSelect
}: {
  users: JiraUser[]
  onSelect: (user: JiraUser) => void
}): React.JSX.Element {
  return (
    <>
      {users.map((user) => (
        <button
          key={user.accountId}
          type="button"
          onClick={() => onSelect(user)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
        >
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="size-5 rounded-full" />
          ) : null}
          <span className="truncate">{user.displayName}</span>
        </button>
      ))}
    </>
  )
}

/** User fields require accountId values; Jira rejects display-name strings. */
export type JiraUserPickerFixedOption = {
  key: string
  label: string
  onSelect: () => void
}

function matchesJiraUserQuery(user: JiraUser, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return true
  }
  return (
    user.displayName.toLowerCase().includes(needle) ||
    (user.email?.toLowerCase().includes(needle) ?? false)
  )
}

/**
 * Splits picker candidates into the people pinned above the list — the current user
 * and the project's roster, in the order the caller passed them — and the rest of the
 * matches. The pinned side is narrowed by `query` and both sides are deduped by account,
 * so a typed query trims the pinned group instead of pushing the whole list below it.
 * Candidates are left as the caller sent them: a site that matches on username rather
 * than display name would lose real hits to a second, local filter.
 */
export function splitJiraUserPickerOptions({
  candidates,
  pinned,
  query
}: {
  candidates: JiraUser[]
  pinned: JiraUser[]
  query: string
}): { pinned: JiraUser[]; rest: JiraUser[] } {
  const claimed = new Set<string>()
  const pinnedUsers: JiraUser[] = []
  for (const user of pinned) {
    if (claimed.has(user.accountId) || !matchesJiraUserQuery(user, query)) {
      continue
    }
    claimed.add(user.accountId)
    pinnedUsers.push(user)
  }
  const rest = candidates.filter((user) => {
    if (claimed.has(user.accountId)) {
      return false
    }
    claimed.add(user.accountId)
    return true
  })
  return { pinned: pinnedUsers, rest }
}

/** Debounced candidate lookup shared by the Jira user pickers, run while `active`.
 *  `searchUsers` must be referentially stable, or the search restarts on every render. */
export function useJiraUserSearch({
  active,
  query,
  searchUsers
}: {
  active: boolean
  query: string
  searchUsers: (query: string) => Promise<JiraUser[]>
}): { users: JiraUser[]; loading: boolean; error: string | null } {
  const [users, setUsers] = useState<JiraUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      // Why: a lookup abandoned by closing the picker must not leave it spinning.
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    // Why: the previous query's matches must not sit under the new query while it is in flight.
    setUsers([])
    const timer = setTimeout(() => {
      void searchUsers(query)
        .then((found) => {
          if (!cancelled) {
            setUsers(found)
          }
        })
        .catch((failure: unknown) => {
          if (!cancelled) {
            setUsers([])
            // Why: an empty list from a failed lookup would read as "nobody is
            // assignable", which is a claim this read never made.
            setError(
              extractIpcErrorMessage(
                failure,
                translate(
                  'components.jiraUserPicker.searchFailed',
                  'Could not load people assignable to this issue.'
                )
              )
            )
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false)
          }
        })
    }, USER_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, query, searchUsers])

  return { users, loading, error }
}

export function JiraUserPicker({
  providerSettings,
  siteId,
  value,
  selectedUser,
  onSelect,
  disabled,
  label,
  fixedOptions,
  searchUsers,
  allowKnownUserId
}: {
  providerSettings: RuntimeJiraSettings
  siteId?: string | null
  value: string
  selectedUser: JiraUser | null
  onSelect: (user: JiraUser) => void
  disabled?: boolean
  label: string
  /** Rows pinned above the search results, e.g. "Automatic" or "Assign to me". */
  fixedOptions?: JiraUserPickerFixedOption[]
  /** Replaces the site-wide user search, e.g. with a project-scoped assignable search. Must be referentially stable. */
  searchUsers?: (query: string) => Promise<JiraUser[]>
  allowKnownUserId?: boolean
}): React.JSX.Element {
  const languageRevision = useUiLanguageRevision()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const defaultSearch = useCallback(
    (value: string) => jiraSearchUsers(providerSettings, value, siteId),
    [providerSettings, siteId]
  )
  const { users, loading, error } = useJiraUserSearch({
    active: open,
    query,
    searchUsers: searchUsers ?? defaultSearch
  })
  const knownUserId = query.trim()

  const selectUser = useCallback(
    (user: JiraUser) => {
      onSelect(user)
      setOpen(false)
    },
    [onSelect]
  )

  const triggerLabel = useMemo(() => {
    if (selectedUser?.displayName) {
      return selectedUser.displayName
    }
    return (
      value ||
      translate('components.jiraUserPicker.select', 'Select {{value0}}', {
        value0: label
      })
    )
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [label, selectedUser, value, languageRevision])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2 text-left text-xs transition hover:bg-muted/40 disabled:opacity-50"
        >
          <span className={value ? 'truncate' : 'truncate text-muted-foreground'}>
            {triggerLabel}
          </span>
          {loading ? <LoaderCircle className="size-3 shrink-0 animate-spin" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="popover-scroll-content scrollbar-sleek w-64 p-1" align="start">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={translate('components.jiraUserPicker.search', 'Search users')}
          className="mb-1 h-7"
          autoFocus
        />
        {fixedOptions?.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              option.onSelect()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            {option.label}
          </button>
        ))}
        {error ? (
          <p className="px-2 py-1.5 text-xs text-destructive">{error}</p>
        ) : users.length === 0 && !loading ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {translate('components.jiraUserPicker.empty', 'No users found')}
          </p>
        ) : (
          <JiraUserOptionList users={users} onSelect={selectUser} />
        )}
        {allowKnownUserId && knownUserId ? (
          <button
            type="button"
            onClick={() => {
              onSelect({ accountId: knownUserId, displayName: knownUserId })
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            {translate('components.jiraUserPicker.useKnownId', 'Use known user ID "{{value0}}"', {
              value0: knownUserId
            })}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
