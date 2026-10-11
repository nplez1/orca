import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  isSshTargetHidden,
  type SshConnectionState,
  type SshTarget
} from '../../../../shared/ssh-types'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetServerStatus } from './SshTargetServerStatus'
import { SshTargetsEmptyState } from './SshTargetsEmptyState'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

export type SshTargetListProps = {
  targets: SshTarget[]
  connectionStates: Map<string, SshConnectionState>
  testingIds: Set<string>
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  onConnect: (targetId: string) => void | Promise<void>
  onDisconnect: (targetId: string) => void | Promise<void>
  onTest: (targetId: string) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (target: SshTarget) => void
  onSetHidden: (target: SshTarget, hidden: boolean) => void | Promise<void>
  onChanged: () => void
}

/**
 * The SSH host list, split into hosts that are offered and hosts the user hid.
 *
 * Why hidden hosts stay on this screen at all: they are the ones Orca discovered in
 * ~/.ssh/config, so they come back on every sync — Settings is the one place that can
 * show the choice and undo it. Every host picker filters on `hiddenSshTargetIds`
 * instead, so hiding never strands a workspace bound to the host.
 */
export function SshTargetList({
  targets,
  connectionStates,
  testingIds,
  busyActionForTarget,
  onConnect,
  onDisconnect,
  onTest,
  onEdit,
  onRemove,
  onSetHidden,
  onChanged
}: SshTargetListProps): React.JSX.Element {
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  const visibleTargets = targets.filter((target) => !isSshTargetHidden(target))
  const hiddenTargets = targets.filter((target) => isSshTargetHidden(target))

  const renderTarget = (target: SshTarget): React.JSX.Element => (
    <div key={target.id} className="space-y-1">
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
        onSetHidden={(hidden) => onSetHidden(target, hidden)}
      />
      <SshTargetServerStatus target={target} onChanged={onChanged} />
    </div>
  )

  if (targets.length === 0) {
    return <SshTargetsEmptyState />
  }

  return (
    <>
      <div className="space-y-2">{visibleTargets.map(renderTarget)}</div>
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
              {hiddenTargets.map(renderTarget)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  )
}
