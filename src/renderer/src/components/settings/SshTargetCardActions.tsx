import {
  CircleStop,
  Loader2,
  MonitorSmartphone,
  Pencil,
  RotateCcw,
  Server,
  ServerOff,
  Trash2
} from 'lucide-react'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { SshTargetVisibilityToggle } from './SshTargetVisibilityToggle'
import { isSshTargetConnecting } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

type SshTargetCardActionsProps = {
  status: SshConnectionStatus
  testing: boolean
  actionInFlight: 'connect' | 'disconnect' | 'terminate' | 'reset' | null
  hasActionInFlight: boolean
  terminateInFlight: boolean
  resetInFlight: boolean
  removeInFlight: boolean
  hidden: boolean
  hideable: boolean
  visibilityInFlight: boolean
  onConnect: () => void | Promise<void>
  onDisconnect: () => void | Promise<void>
  onTerminateSessions: () => void | Promise<void>
  onResetRelay: () => void | Promise<void>
  onTest: () => void | Promise<void>
  onEdit: () => void
  onRemove: () => void
  onSetHidden: (hidden: boolean) => void | Promise<void>
}

export function SshTargetCardActions({
  status,
  testing,
  actionInFlight,
  hasActionInFlight,
  terminateInFlight,
  resetInFlight,
  removeInFlight,
  hidden,
  hideable,
  visibilityInFlight,
  onConnect,
  onDisconnect,
  onTerminateSessions,
  onResetRelay,
  onTest,
  onEdit,
  onRemove,
  onSetHidden
}: SshTargetCardActionsProps): React.JSX.Element {
  const renderEndRemoteTerminalsButton = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onTerminateSessions}
          className="size-7 text-muted-foreground hover:text-red-400"
          disabled={hasActionInFlight}
          aria-label={
            terminateInFlight
              ? translate(
                  'auto.components.settings.SshTargetCard.c77f1abfe3',
                  'Ending remote terminals'
                )
              : translate(
                  'auto.components.settings.SshTargetCard.da16e108e6',
                  'End remote terminals'
                )
          }
        >
          {terminateInFlight ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <CircleStop className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate('auto.components.settings.SshTargetCard.da16e108e6', 'End remote terminals')}
      </TooltipContent>
    </Tooltip>
  )

  const renderResetRelayButton = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onResetRelay}
          className="size-7 text-muted-foreground hover:text-red-400"
          disabled={hasActionInFlight}
          aria-label={
            resetInFlight
              ? translate(
                  'auto.components.settings.SshTargetCard.97dea4e8cf',
                  'Resetting remote relay'
                )
              : translate('auto.components.settings.SshTargetCard.762a48c662', 'Reset remote relay')
          }
        >
          {resetInFlight ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCcw className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate('auto.components.settings.SshTargetCard.762a48c662', 'Reset remote relay')}
      </TooltipContent>
    </Tooltip>
  )

  const renderVisibilityAction = (): React.JSX.Element =>
    hideable ? (
      <SshTargetVisibilityToggle
        hidden={hidden}
        disabled={hasActionInFlight}
        busy={visibilityInFlight}
        onSetHidden={onSetHidden}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            className="size-7 text-muted-foreground hover:text-red-400"
            disabled={hasActionInFlight}
            aria-label={
              removeInFlight
                ? translate('auto.components.settings.SshTargetCard.3d21a22d0e', 'Removing target')
                : translate('auto.components.settings.SshTargetCard.7f7b3d7ab4', 'Remove target')
            }
          >
            {removeInFlight ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('auto.components.settings.SshTargetCard.7f7b3d7ab4', 'Remove target')}
        </TooltipContent>
      </Tooltip>
    )

  const renderSecondaryIconActions = (includeEndRemoteTerminals: boolean): React.JSX.Element => (
    <div className="flex items-center gap-1">
      {includeEndRemoteTerminals ? renderEndRemoteTerminalsButton() : null}
      {isSshTargetConnecting(status) ? null : renderResetRelayButton()}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            className="size-7"
            disabled={hasActionInFlight}
            aria-label={translate(
              'auto.components.settings.SshTargetCard.3d8af2949f',
              'Edit target'
            )}
          >
            <Pencil className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('auto.components.settings.SshTargetCard.3d8af2949f', 'Edit target')}
        </TooltipContent>
      </Tooltip>
      {renderVisibilityAction()}
    </div>
  )

  return (
    <div className="flex shrink-0 items-center gap-1">
      {status === 'connected' ? (
        <>
          {renderSecondaryIconActions(true)}
          <Button
            variant="ghost"
            size="xs"
            onClick={onDisconnect}
            className="gap-1.5"
            disabled={hasActionInFlight}
          >
            <ServerOff className="size-3" />
            {translate('auto.components.settings.SshTargetCard.4c86f30877', 'Disconnect')}
          </Button>
        </>
      ) : isSshTargetConnecting(status) ? (
        <>
          {renderSecondaryIconActions(false)}
          <Button variant="ghost" size="xs" disabled className="gap-1.5">
            <Loader2 className="size-3 animate-spin" />
            {translate('auto.components.settings.SshTargetCard.1810b51482', 'Connecting')}
          </Button>
        </>
      ) : (
        <>
          {renderSecondaryIconActions(true)}
          <Button
            variant="ghost"
            size="xs"
            onClick={onTest}
            disabled={testing || hasActionInFlight}
            className="gap-1.5"
          >
            {testing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <MonitorSmartphone className="size-3" />
            )}
            {translate('auto.components.settings.SshTargetCard.0e53e9f8e8', 'Test')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={onConnect}
            className="gap-1.5"
            disabled={hasActionInFlight}
          >
            {actionInFlight === 'connect' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Server className="size-3" />
            )}
            {translate('auto.components.settings.SshTargetCard.ec6543cee9', 'Connect')}
          </Button>
        </>
      )}
    </div>
  )
}
