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
import type { SshTargetBusyAction } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

export type SshTargetListProps = {
  targets: SshTarget[]
  connectionStates: Map<string, SshConnectionState>
  testingIds: Set<string>
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  /** Handlers take no target: this list already binds each row. */
  onConnect: (target: SshTarget) => void | Promise<void>
  onDisconnect: (target: SshTarget) => void | Promise<void>
  onTerminateSessions: (target: SshTarget) => void
  onResetRelay: (target: SshTarget) => void
  onTest: (target: SshTarget) => void | Promise<void>
  onEdit: (target: SshTarget) => void
  onRemove: (target: SshTarget) => void
  onSetHidden: (target: SshTarget, hidden: boolean) => void | Promise<void>
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
  onTerminateSessions,
  onResetRelay,
  onTest,
  onEdit,
  onRemove,
  onSetHidden
}: SshTargetListProps): React.JSX.Element {
  const [hiddenExpanded, setHiddenExpanded] = useState(false)
  const visibleTargets = targets.filter((target) => !isSshTargetHidden(target))
  const hiddenTargets = targets.filter((target) => isSshTargetHidden(target))

  const renderTargetCard = (target: SshTarget): React.JSX.Element => (
    <SshTargetCard
      key={target.id}
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
  )

  if (targets.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-sm text-muted-foreground">
        {translate('auto.components.settings.SshPane.c0f1c80166', 'No SSH targets configured.')}
      </div>
    )
  }

  return (
    <>
      <div className="space-y-2">{visibleTargets.map(renderTargetCard)}</div>
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
              {hiddenTargets.map(renderTargetCard)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  )
}
