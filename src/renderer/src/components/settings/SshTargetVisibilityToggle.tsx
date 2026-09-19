import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

type SshTargetVisibilityToggleProps = {
  hidden: boolean
  disabled: boolean
  busy: boolean
  onSetHidden: (hidden: boolean) => void | Promise<void>
}

/**
 * Hide/unhide toggle for a host Orca discovered in ~/.ssh/config.
 *
 * Why this is not the trashcan: a discovered host returns on every config sync, so
 * deleting it never sticks. Hiding is the durable gesture and it is reversible, so it
 * must not carry a destructive affordance or a destructive hover color.
 */
export function SshTargetVisibilityToggle({
  hidden,
  disabled,
  busy,
  onSetHidden
}: SshTargetVisibilityToggleProps): React.JSX.Element {
  const label = hidden
    ? translate('auto.components.settings.SshTargetVisibilityToggle.unhide', 'Unhide host')
    : translate('auto.components.settings.SshTargetVisibilityToggle.hide', 'Hide host')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void onSetHidden(!hidden)}
          className="size-7"
          disabled={disabled || busy}
          aria-label={label}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : hidden ? (
            <Eye className="size-3" />
          ) : (
            <EyeOff className="size-3" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
