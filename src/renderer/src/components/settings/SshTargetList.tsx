import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  isSshTargetHidden,
  type SshConnectionState,
  type SshTarget
} from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Checkbox } from '../ui/checkbox'
import { VirtualizedList } from '../virtualized-list'
import { useSettingsContentScrollElement } from './settings-content-scroll-element'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import {
  groupSshTargetsBySource,
  sshTargetGroupCheckState,
  type SshTargetGroup,
  type SshTargetGroupId
} from './ssh-target-list-model'
import { SshTargetCard } from './SshTargetCard'
import type { SshTargetSelection } from './use-ssh-target-selection'

type SshTargetListProps = {
  targets: readonly SshTarget[]
  /** Unfiltered group sizes, so a filtered group reads "2 of 17" rather than shrinking silently. */
  totalBySource: Record<SshTargetGroupId, number>
  connectionStates: ReadonlyMap<string, SshConnectionState>
  testingIds: ReadonlySet<string>
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  selection: SshTargetSelection
  onConnect: (targetId: string) => void | Promise<void>
  onDisconnect: (targetId: string) => void | Promise<void>
  onTest: (targetId: string) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (target: SshTarget) => void
  onServerChanged: () => void
  /** Hide/unhide for a host ~/.ssh/config keeps re-importing. */
  onSetHidden?: (target: SshTarget, hidden: boolean) => void | Promise<void>
}

function groupTitle(group: SshTargetGroup): React.JSX.Element {
  if (group.id === 'manual') {
    return <>{translate('auto.components.settings.SshTargetList.addedInOrca', 'Added in Orca')}</>
  }
  return <>{translate('auto.components.settings.SshTargetList.fromConfig', 'From ~/.ssh/config')}</>
}

// Why: a generated ~/.ssh/config can import >10k hosts; a card each cost GBs of DOM, so rows window.
const SSH_TARGET_ROW_ESTIMATE_PX = 52

/**
 * Splits the hosts the screen offers from the ones the user hid. A hidden host keeps its
 * workspaces and sessions; it only leaves every host picker, so Settings can undo it.
 */
export function partitionSshTargetsByVisibility(targets: readonly SshTarget[]): {
  offered: SshTarget[]
  hidden: SshTarget[]
} {
  return {
    offered: targets.filter((target) => !isSshTargetHidden(target)),
    hidden: targets.filter((target) => isSshTargetHidden(target))
  }
}

const NOT_LIST_CONTEXT = '[role="dialog"], [role="alertdialog"], [role="menu"], pre, textarea'

/**
 * ⌘/Ctrl-A selects hosts only from the list's own row controls. React bubbles keydown through
 * portals, so a row's dialog, menu, or copyable detail text would otherwise lose select-all-text.
 */
export function isListOwnSelectAllTarget(list: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !list.contains(target)) {
    return false
  }
  if (
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return false
  }
  return target.closest(NOT_LIST_CONTEXT) === null
}

/** Hosts grouped by where they came from, each group selectable as a whole. */
export function SshTargetList({
  targets,
  totalBySource,
  connectionStates,
  testingIds,
  busyActionForTarget,
  selection,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onRemove,
  onServerChanged,
  onSetHidden
}: SshTargetListProps): React.JSX.Element {
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  // Why: hidden hosts stay on this screen — they are the ones Orca discovered in ~/.ssh/config,
  // so they come back on every sync and Settings is the one place that can undo the choice.
  const { offered: visibleTargets, hidden: hiddenTargets } =
    partitionSshTargetsByVisibility(targets)
  const groups = groupSshTargetsBySource(visibleTargets)
  const scrollElement = useSettingsContentScrollElement()
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <div
      className="space-y-3"
      onKeyDown={(event) => {
        const mod = isMac ? event.metaKey : event.ctrlKey
        if (
          mod &&
          event.key.toLowerCase() === 'a' &&
          isListOwnSelectAllTarget(event.currentTarget, event.target)
        ) {
          event.preventDefault()
          selection.setGroup(
            visibleTargets.map((target) => target.id),
            true
          )
        }
      }}
    >
      {groups.map((group) => {
        const ids = group.targets.map((target) => target.id)
        const checkState = sshTargetGroupCheckState(selection.selected, ids)
        return (
          <section
            key={group.id}
            data-ssh-target-group={group.id}
            className="overflow-hidden rounded-lg border border-border/60"
          >
            <div className="flex items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 has-[[data-slot=checkbox]:focus-visible]:ring-2 has-[[data-slot=checkbox]:focus-visible]:ring-ring/60 has-[[data-slot=checkbox]:focus-visible]:ring-inset">
              <Checkbox
                checked={checkState}
                aria-label={
                  group.id === 'manual'
                    ? translate(
                        'auto.components.settings.SshTargetList.selectManualGroup',
                        'Select all hosts added in Orca'
                      )
                    : translate(
                        'auto.components.settings.SshTargetList.selectConfigGroup',
                        'Select all hosts from ~/.ssh/config'
                      )
                }
                onCheckedChange={() => selection.setGroup(ids, checkState !== true)}
              />
              <span className="text-xs font-medium text-foreground">
                {groupTitle(group)}
                <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                  ·{' '}
                  {group.targets.length < totalBySource[group.id]
                    ? translate(
                        'auto.components.settings.SshTargetList.filteredCount',
                        '{{count}} of {{total}}',
                        { count: group.targets.length, total: totalBySource[group.id] }
                      )
                    : group.targets.length}
                </span>
              </span>
            </div>
            <VirtualizedList
              rows={group.targets}
              getRowKey={(target) => target.id}
              scrollElement={scrollElement}
              estimateRowHeightPx={SSH_TARGET_ROW_ESTIMATE_PX}
              renderRow={(target) => (
                // Why per-row borders: windowed rows are absolutely positioned, so divide-y can't reach them.
                <div
                  key={target.id}
                  data-first-row={target === group.targets[0] ? 'true' : undefined}
                  className="border-t border-border/40 data-[first-row=true]:border-t-0"
                >
                  <SshTargetCard
                    target={target}
                    state={connectionStates.get(target.id)}
                    testing={testingIds.has(target.id)}
                    busyAction={busyActionForTarget(target.id)}
                    selected={selection.selected.has(target.id)}
                    onSelectClick={selection.click}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                    onTest={onTest}
                    onEdit={onEdit}
                    onRemove={() => onRemove(target)}
                    onServerChanged={onServerChanged}
                    onSetHidden={onSetHidden ? (hidden) => onSetHidden(target, hidden) : undefined}
                  />
                </div>
              )}
            />
          </section>
        )
      })}
      {hiddenTargets.length > 0 ? (
        <Collapsible open={hiddenExpanded} onOpenChange={setHiddenExpanded}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="-ml-2">
              <ChevronRight
                className={cn('size-3.5 transition-transform', hiddenExpanded && 'rotate-90')}
              />
              {translate(
                'auto.components.settings.SshTargetList.hiddenSection',
                'Hidden ({{value0}})',
                { value0: hiddenTargets.length }
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-2 pt-2">
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetList.hiddenSectionHint',
                  'These hosts come from your SSH config. They stay out of the lists where you pick a host, but anything already running on them keeps working.'
                )}
              </p>
              {hiddenTargets.map((target) => (
                <div key={target.id} className="overflow-hidden rounded-lg border border-border/60">
                  <SshTargetCard
                    target={target}
                    state={connectionStates.get(target.id)}
                    testing={testingIds.has(target.id)}
                    busyAction={busyActionForTarget(target.id)}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                    onTest={onTest}
                    onEdit={onEdit}
                    onRemove={() => onRemove(target)}
                    onServerChanged={onServerChanged}
                    onSetHidden={onSetHidden ? (hidden) => onSetHidden(target, hidden) : undefined}
                  />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  )
}
