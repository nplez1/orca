import { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react'
import type { JiraUser } from '../../../shared/jira/jira-types'
import { splitJiraFieldDraft } from '../../../shared/jira-field-draft'
import { useJiraUserSearch } from '@/components/jira-user-picker'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { jiraSearchUsers, type RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'

/** The people a draft already names, in draft order. A held accountId the site gives no
 *  name for is shown as itself: the picker has to offer a row for it, or it could never
 *  be removed. */
export function jiraHeldUsers(users: readonly JiraUser[], value: string): JiraUser[] {
  const byId = new Map(users.map((user) => [user.accountId, user]))
  // Why dedupe: two draft entries naming the same person would give duplicate keys and a
  // payload Jira rejects.
  return [...new Set(splitJiraFieldDraft(value))].map(
    (token) => byId.get(token) ?? { accountId: token, displayName: token }
  )
}

/**
 * A Jira multi-user field: the people are named, never numbered. Jira's accountIds are
 * what the payload carries, but they mean nothing to the person filling the form, so the
 * control holds them and shows display names instead of asking the user to type or read
 * accountIds.
 */
export function JiraUserMultiPicker({
  providerSettings,
  siteId,
  value,
  users,
  onChange,
  disabled,
  label,
  placeholder
}: {
  providerSettings: RuntimeJiraSettings
  siteId?: string | null
  /** The draft: comma-separated accountIds, never names. */
  value: string
  /** The people the draft already names, so they show before any search runs. */
  users: readonly JiraUser[]
  onChange: (users: JiraUser[]) => void
  disabled?: boolean
  label: string
  placeholder: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const held = useMemo(() => jiraHeldUsers(users, value), [users, value])
  const heldIds = useMemo(() => new Set(held.map((user) => user.accountId)), [held])
  const searchUsers = useCallback(
    (search: string) => jiraSearchUsers(providerSettings, search, siteId),
    [providerSettings, siteId]
  )
  const { users: found, loading } = useJiraUserSearch({ active: open, query, searchUsers })
  const results = useMemo(
    () => found.filter((user) => !heldIds.has(user.accountId)),
    [found, heldIds]
  )

  const toggle = (user: JiraUser): void => {
    onChange(
      heldIds.has(user.accountId)
        ? held.filter((entry) => entry.accountId !== user.accountId)
        : [...held, user]
    )
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      // Why: reopening starts a fresh lookup rather than re-showing the last query's
      // results as if they answered the empty field.
      setQuery('')
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={label}
          disabled={disabled}
          className="w-full justify-between"
          title={held.length > 0 ? held.map((user) => user.displayName).join(', ') : undefined}
        >
          <span
            className={
              held.length > 0
                ? 'min-w-0 truncate font-normal'
                : 'min-w-0 truncate font-normal text-muted-foreground'
            }
          >
            {held.length > 0 ? held.map((user) => user.displayName).join(', ') : placeholder}
          </span>
          {loading ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin opacity-50" />
          ) : (
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)]">
        <Command density="menu" label={label} shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={translate('components.jiraUserPicker.search', 'Search users')}
          />
          <CommandList animateHeight>
            {/* Why held rows sit above the results and ignore the query: the current
                selection has to stay visible and removable while a search is typed. */}
            {held.map((user) => (
              <CommandItem
                key={user.accountId}
                value={user.accountId}
                aria-checked
                data-state="checked"
                onSelect={() => toggle(user)}
              >
                <Check className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
                {user.email ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">{user.email}</span>
                ) : null}
              </CommandItem>
            ))}
            {results.map((user) => (
              <CommandItem
                key={user.accountId}
                value={user.accountId}
                aria-checked={false}
                data-state="unchecked"
                onSelect={() => toggle(user)}
              >
                <Check className="size-3.5 shrink-0 opacity-0" />
                <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
                {user.email ? (
                  <span className="shrink-0 text-3xs text-muted-foreground">{user.email}</span>
                ) : null}
              </CommandItem>
            ))}
            {results.length === 0 && !loading ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {held.length > 0
                  ? translate(
                      'components.jiraUserMultiPicker.noOtherMatch',
                      'No other users match.'
                    )
                  : translate('components.jiraUserPicker.empty', 'No users found')}
              </p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
