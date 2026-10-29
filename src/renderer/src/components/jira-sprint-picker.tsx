import React, { useMemo, useState } from 'react'
import { Check } from 'lucide-react'

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { matchesCommandTerms } from '@/lib/command-choice-filter'
import type { JiraSprint } from '../../../shared/jira/jira-types'
import { sortJiraSprintsNearToday } from './jira-sprint-sorter'

// Why a sentinel: cmdk cannot select an item whose value is an empty string, and the
// backlog is what unassigning means here.
const BACKLOG_OPTION_VALUE = '__jira_backlog__'

/** Keeps the proximity order while typing: an option's `value` here is its id, so only
 *  the labels are searched — otherwise "8" would match every sprint whose id holds one. */
function sprintChoiceFilter(_value: string, search: string, keywords?: string[]): number {
  return matchesCommandTerms(search, keywords ?? []) ? 1 : 0
}

/** What a sprint control reads when the issue is in no sprint. */
export function backlogLabel(): string {
  return translate('auto.components.JiraSprintPicker.backlog', 'Backlog')
}

/** What a sprint control's trigger reads: the current sprint, or the add action. */
export function sprintTriggerLabel(sprint: JiraSprint | null): string {
  return sprint?.name ?? translate('auto.components.JiraSprintPicker.addToSprint', '+ Sprint')
}

function sprintStateLabel(state: string): string | null {
  if (state === 'active') {
    return translate('auto.components.JiraSprintPicker.active', 'Active')
  }
  return state === 'future' ? translate('auto.components.JiraSprintPicker.future', 'Future') : null
}

function SprintOptionBody({
  label,
  state,
  current
}: {
  label: string
  state: string | null
  current: boolean
}): React.JSX.Element {
  return (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {current ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {state ? <span className="shrink-0 text-3xs text-muted-foreground">{state}</span> : null}
    </>
  )
}

/** Sprint picker shared by the issue drawer and the backlog rows.
 *
 *  The trigger is the caller's own element so each surface keeps its row or chip
 *  styling. `sprint: null` is the backlog, so the Backlog entry is what unassigns;
 *  a caller whose every row is already in the backlog drops that entry.
 *
 *  Searchable because a production board carries hundreds of sprints: the list is
 *  ranked around today (see `sortJiraSprintsNearToday`) and filtered by typed text,
 *  rather than making the user scroll past years of history. */
export function JiraSprintPicker({
  sprint,
  sprints,
  onSelect,
  children,
  includeBacklog = true,
  align = 'start'
}: {
  sprint: JiraSprint | null
  sprints: JiraSprint[]
  onSelect: (sprintId: string | null) => void
  children: React.ReactNode
  includeBacklog?: boolean
  align?: 'start' | 'end'
}): React.JSX.Element {
  // Why the open timestamp rather than reading the clock during render: the ranking is
  // relative to "now", and a render has to stay pure. Sampling it on open also means a
  // long-lived drawer re-ranks against the day it is reopened.
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  const currentSprintId = sprint?.id ?? null
  const ranked = useMemo(
    () => (openedAt === null ? [] : sortJiraSprintsNearToday(sprints, currentSprintId, openedAt)),
    [currentSprintId, openedAt, sprints]
  )
  const choose = (sprintId: string | null): void => {
    setOpenedAt(null)
    // Why: the current sprint is listed so the picker shows where the issue already is,
    // and re-picking it is not a change — it may also be a closed sprint, which Jira
    // refuses to receive an issue.
    if (sprintId !== currentSprintId) {
      onSelect(sprintId)
    }
  }

  return (
    <Popover
      open={openedAt !== null}
      onOpenChange={(nextOpen) => setOpenedAt(nextOpen ? Date.now() : null)}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64" align={align}>
        <Command
          density="menu"
          label={translate('auto.components.JiraSprintPicker.sprint', 'Sprint')}
          filter={sprintChoiceFilter}
          // Why: the picker sits inside a clickable issue row, and React bubbles a
          // portalled popover's clicks up the component tree to that row's handler.
          onClick={(event) => event.stopPropagation()}
        >
          <CommandInput
            placeholder={translate('auto.components.JiraSprintPicker.findSprint', 'Find a sprint…')}
          />
          <CommandList animateHeight>
            <CommandEmpty>
              {translate('auto.components.JiraSprintPicker.noSprintMatch', 'No sprint matches.')}
            </CommandEmpty>
            {includeBacklog ? (
              <CommandItem
                value={BACKLOG_OPTION_VALUE}
                keywords={[backlogLabel()]}
                onSelect={() => choose(null)}
              >
                <SprintOptionBody
                  label={backlogLabel()}
                  state={null}
                  current={currentSprintId === null}
                />
              </CommandItem>
            ) : null}
            {ranked.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                keywords={[option.name, sprintStateLabel(option.state) ?? '']}
                onSelect={() => choose(option.id)}
              >
                <SprintOptionBody
                  label={option.name}
                  state={sprintStateLabel(option.state)}
                  current={option.id === currentSprintId}
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
