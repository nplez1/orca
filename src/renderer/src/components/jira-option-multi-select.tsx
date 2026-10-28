import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { JiraCreateFieldAllowedValue } from '../../../shared/jira/jira-types'
import { splitJiraFieldDraft, joinJiraFieldDraft } from '../../../shared/jira-field-draft'
import {
  findJiraCreateAllowedValue,
  getJiraCreateAllowedValueLabel
} from '@/components/task-page/jira/task-page-jira-create-fields'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { matchesCommandTerms } from '@/lib/command-choice-filter'
import { translate } from '@/i18n/i18n'

/**
 * The token an option control holds for one allowed value: the id Jira's own payload
 * needs, so a site can rename the option without stranding the value. The control emits
 * these, which is what keeps the labels it displays out of the draft.
 */
export function jiraOptionToken(option: JiraCreateFieldAllowedValue): string {
  return option.id ?? option.value ?? option.name ?? ''
}

/** Searchable by label only: an option's `value` is its id, so matching on it would
 *  let "184" find every option whose id happens to hold those digits. */
function jiraOptionChoiceFilter(_value: string, search: string, keywords?: string[]): number {
  return matchesCommandTerms(search, keywords ?? []) ? 1 : 0
}

/** The option a draft token names. A token arrives as an id, a value or a name — the
 *  edit form's draft, a create-screen default and a hand-edited field all differ — so
 *  the control resolves it before it can tick a row. */
export function jiraOptionForToken(
  options: readonly JiraCreateFieldAllowedValue[],
  token: string
): JiraCreateFieldAllowedValue | undefined {
  return findJiraCreateAllowedValue({ allowedValues: options }, token)
}

/** The token a draft holds for an entry: the id when there is one. */
function canonicalToken(options: readonly JiraCreateFieldAllowedValue[], token: string): string {
  const option = jiraOptionForToken(options, token)
  return option ? jiraOptionToken(option) : token
}

/** The labels for a draft's tokens, in draft order. A token the allowed-value list
 *  omits keeps whatever the issue holds, which for an option value is already a label. */
export function jiraOptionLabels(
  options: readonly JiraCreateFieldAllowedValue[],
  value: string
): string[] {
  return splitJiraFieldDraft(value).map((token) => {
    const option = jiraOptionForToken(options, token)
    return option ? getJiraCreateAllowedValueLabel(option) : token
  })
}

/**
 * A Jira multi-select option field: the options are named, never numbered. Jira's
 * option ids are what the payload carries and what the issue holds, but they mean
 * nothing to the person filling the form, so the control holds them and shows the
 * labels instead of asking the user to type or read ids.
 */
export function JiraOptionMultiSelect({
  options,
  value,
  onValueChange,
  disabled,
  placeholder
}: {
  options: readonly JiraCreateFieldAllowedValue[]
  /** The draft as the edit form holds it: comma-separated option tokens. A token can
   *  arrive as an id, a value or a name, so the control resolves each one. */
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  placeholder: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const entries = useMemo(
    () =>
      options
        .map((option) => ({
          token: jiraOptionToken(option),
          label: getJiraCreateAllowedValueLabel(option)
        }))
        .filter((entry) => entry.token),
    [options]
  )
  const selectedLabels = useMemo(() => jiraOptionLabels(options, value), [options, value])
  // Canonical tokens the draft already names, whatever form each one arrived in.
  const selected = useMemo(
    () => new Set(splitJiraFieldDraft(value).map((token) => canonicalToken(options, token))),
    [options, value]
  )
  // A value Jira no longer offers is still on the issue. It gets its own checked row,
  // or the control would hold something the user can see and never remove.
  const orphanTokens = useMemo(() => {
    const offered = new Set(entries.map((entry) => entry.token))
    return [...selected].filter((token) => !offered.has(token))
  }, [entries, selected])

  const toggle = (token: string): void => {
    const held = splitJiraFieldDraft(value).map((entry) => canonicalToken(options, entry))
    const next = selected.has(token) ? held.filter((entry) => entry !== token) : [...held, token]
    // Why the set: two draft entries can name the same option, and Jira rejects the
    // same id twice in one payload.
    onValueChange(joinJiraFieldDraft([...new Set(next)]))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          className="w-full justify-between"
          title={selectedLabels.length > 0 ? selectedLabels.join(', ') : undefined}
        >
          <span
            className={
              selectedLabels.length > 0
                ? 'min-w-0 truncate font-normal'
                : 'min-w-0 truncate font-normal text-muted-foreground'
            }
          >
            {selectedLabels.length > 0 ? selectedLabels.join(', ') : placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)]">
        <Command density="menu" label={placeholder} filter={jiraOptionChoiceFilter}>
          <CommandInput
            autoFocus
            placeholder={translate('components.jiraOptionMultiSelect.search', 'Search options...')}
          />
          <CommandList animateHeight>
            <CommandEmpty>
              {translate(
                'components.jiraOptionMultiSelect.noMatch',
                'No options match your search.'
              )}
            </CommandEmpty>
            {[...entries, ...orphanTokens.map((token) => ({ token, label: token }))].map(
              (entry) => {
                const isSelected = selected.has(entry.token)
                return (
                  <CommandItem
                    key={entry.token}
                    value={entry.token}
                    keywords={[entry.label]}
                    aria-checked={isSelected}
                    data-state={isSelected ? 'checked' : 'unchecked'}
                    onSelect={() => toggle(entry.token)}
                  >
                    <Check
                      className={isSelected ? 'size-3.5 shrink-0' : 'size-3.5 shrink-0 opacity-0'}
                    />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  </CommandItem>
                )
              }
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
