import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'

/** One selectable person, normalized across Jira / Linear / GitHub. */
export type IssueAssigneeOption = {
  id: string
  label: string
  avatarUrl?: string | null
  /** Secondary identities a typed query may match (Linear email, GitHub login). */
  email?: string | null
  login?: string | null
}

const SEARCH_DEBOUNCE_MS = 250
const DEFAULT_LIST_LIMIT = 6

function orderWithSelfFirst(
  options: IssueAssigneeOption[],
  isSelf?: (option: IssueAssigneeOption) => boolean
): IssueAssigneeOption[] {
  if (!isSelf) {
    return options
  }
  const self = options.filter(isSelf)
  return self.length === 0 ? options : [...self, ...options.filter((option) => !isSelf(option))]
}

export function filterAssigneeOptions(
  options: IssueAssigneeOption[],
  query: string
): IssueAssigneeOption[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return options
  }
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      (option.email?.toLowerCase().includes(needle) ?? false) ||
      (option.login?.toLowerCase().includes(needle) ?? false)
  )
}

function AssigneeAvatar({
  option,
  className
}: {
  option: IssueAssigneeOption
  className?: string
}): React.JSX.Element {
  if (option.avatarUrl) {
    return <img src={option.avatarUrl} alt="" className={cn('size-4 rounded-full', className)} />
  }
  return (
    <span
      className={cn(
        'flex size-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground',
        className
      )}
      aria-hidden
    >
      {option.label.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** Typeahead assignee picker built for the compressed Issue pane.
 *
 *  Empty query shows a short roster list with the current user pinned first;
 *  typing searches the wider directory when `search` is provided (Jira) and
 *  otherwise filters the roster client-side (Linear / GitHub). */
export function IssueAssigneeCombobox({
  label,
  roster,
  selected,
  isSelf,
  multiple = false,
  search,
  onSelect,
  onUnassign,
  pending = false,
  disabled = false,
  maxDefault = DEFAULT_LIST_LIMIT
}: {
  label: string
  roster: IssueAssigneeOption[]
  selected: IssueAssigneeOption[]
  isSelf?: (option: IssueAssigneeOption) => boolean
  multiple?: boolean
  /** Optional directory search; when absent the roster is filtered locally. */
  search?: (query: string) => Promise<IssueAssigneeOption[]>
  onSelect: (option: IssueAssigneeOption) => void
  onUnassign?: () => void
  pending?: boolean
  disabled?: boolean
  maxDefault?: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<IssueAssigneeOption[] | null>(null)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef(search)
  // Why: latest-callback ref written in an effect — React may replay or discard
  // render work, so a render-time write could leak from UI that never commits.
  useEffect(() => {
    searchRef.current = search
  }, [search])
  const selectedIds = useMemo(() => new Set(selected.map((option) => option.id)), [selected])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSearchResults(null)
      setSearching(false)
    }
  }, [open])

  const trimmedQuery = query.trim()
  useEffect(() => {
    const directorySearch = searchRef.current
    if (!open || !trimmedQuery || !directorySearch) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    let cancelled = false
    setSearchResults([])
    setSearching(true)
    const timer = setTimeout(() => {
      void directorySearch(trimmedQuery)
        .then((found) => {
          if (!cancelled) {
            setSearchResults(found)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchResults([])
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false)
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, trimmedQuery])

  const visible = useMemo(() => {
    if (!trimmedQuery) {
      return orderWithSelfFirst(roster, isSelf).slice(0, maxDefault)
    }
    if (search) {
      return orderWithSelfFirst(searchResults ?? [], isSelf)
    }
    return orderWithSelfFirst(filterAssigneeOptions(roster, trimmedQuery), isSelf)
  }, [isSelf, maxDefault, roster, search, searchResults, trimmedQuery])

  const triggerValue = useMemo(() => {
    if (selected.length === 0) {
      return translate('auto.components.right.sidebar.IssueAssignee.unassigned', 'Unassigned')
    }
    return selected.map((option) => option.label).join(', ')
  }, [selected])
  const handleSelect = useCallback(
    (option: IssueAssigneeOption) => {
      onSelect(option)
      if (!multiple) {
        setOpen(false)
      }
    },
    [multiple, onSelect]
  )
  const loading = searching || pending
  const showEmpty = visible.length === 0 && !searching

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={label}
          aria-label={`${label}, ${triggerValue}`}
          pending={pending}
          disabled={disabled}
          value={
            <span
              className={cn(
                'flex items-center gap-1.5',
                selected.length === 0 && 'text-muted-foreground'
              )}
            >
              {selected.length === 1 ? <AssigneeAvatar option={selected[0]} /> : null}
              <span className="min-w-0 truncate">{triggerValue}</span>
            </span>
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="p-1">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate(
              'auto.components.right.sidebar.IssueAssignee.search',
              'Search people'
            )}
            className="mb-1 h-7"
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto scrollbar-sleek">
            {onUnassign ? (
              <button
                type="button"
                onClick={() => {
                  onUnassign()
                  if (!multiple) {
                    setOpen(false)
                  }
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] text-muted-foreground hover:bg-accent"
              >
                {translate('auto.components.right.sidebar.IssueAssignee.unassigned', 'Unassigned')}
              </button>
            ) : null}
            {searching ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" />
                {translate('auto.components.right.sidebar.IssueAssignee.searching', 'Searching…')}
              </div>
            ) : showEmpty ? (
              <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.IssueAssignee.noResults',
                  'No people found'
                )}
              </p>
            ) : (
              visible.map((option) => {
                const isSelected = selectedIds.has(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => handleSelect(option)}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                      isSelected && 'bg-accent/50'
                    )}
                  >
                    <AssigneeAvatar option={option} />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {isSelf?.(option) ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {translate('auto.components.right.sidebar.IssueAssignee.you', 'You')}
                      </span>
                    ) : null}
                    {isSelected ? (
                      <span className="shrink-0 text-foreground" aria-hidden>
                        ✓
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
            {loading && !searching ? (
              <div className="flex items-center justify-center py-2">
                <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
              </div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
