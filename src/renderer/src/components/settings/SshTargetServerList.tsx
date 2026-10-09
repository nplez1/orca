import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  isSshTargetHidden,
  type SshConnectionState,
  type SshTarget
} from '../../../../shared/ssh-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { SshTargetCard } from './SshTargetCard'
import { SshTargetServerStatus } from './SshTargetServerStatus'
import { SshTargetsEmptyState } from './SshTargetsEmptyState'
import type { SshTargetBusyAction } from './ssh-target-action-state'

type SshTargetServerListProps = {
  targets: SshTarget[]
  connectionStates: Map<string, SshConnectionState>
  testingIds: Set<string>
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  onConnect: (target: SshTarget) => void | Promise<void>
  onDisconnect: (target: SshTarget) => void | Promise<void>
  onTerminateSessions: (target: SshTarget) => void
  onResetRelay: (target: SshTarget) => void
  onTest: (target: SshTarget) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (target: SshTarget) => void
  onSetHidden: (target: SshTarget, hidden: boolean) => void | Promise<void>
  onChanged: () => void
}

/** Renders SSH rows, including hidden-host management and server status. */
export function SshTargetServerList({
  targets,
  connectionStates,
  testingIds,
  busyActionForTarget,
  onConnect,
  onDisconnect,
  onTerminateSessions,
  onResetRelay,
  onTest,
  onEdit,
  onRemove,
  onSetHidden,
  onChanged
}: SshTargetServerListProps): React.JSX.Element {
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
        onConnect={() => onConnect(target)}
        onDisconnect={() => onDisconnect(target)}
        onTerminateSessions={() => onTerminateSessions(target)}
        onResetRelay={() => onResetRelay(target)}
        onTest={() => onTest(target)}
        onEdit={() => onEdit(target)}
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
