import React from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useTranslate } from '@/i18n/use-translate'
import { HostRowIcon } from '../host-row-icon'

/** Glyph for a host that can't run yet: connecting, broken, or merely dormant. */
export function NeedsSetupHostIcon({
  hostId,
  connecting,
  attention
}: {
  hostId: ExecutionHostId
  connecting: boolean
  attention: boolean
}): React.JSX.Element {
  if (connecting) {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  }
  if (attention) {
    return <AlertTriangle className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <HostRowIcon hostId={hostId} />
}

export function ConnectHostButton({
  connecting,
  onConnect
}: {
  connecting: boolean
  onConnect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={connecting}
      className="ml-1 shrink-0 gap-1 self-center text-muted-foreground/70 hover:text-foreground"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        // Keep the picker open so connection progress and resolved host state remain visible.
        onConnect()
      }}
    >
      {connecting ? (
        <>
          <LoaderCircle className="size-3 animate-spin" />
          {t('auto.components.NewWorkspaceComposerCard.connectingHost', 'Connecting…')}
        </>
      ) : (
        t('auto.components.NewWorkspaceComposerCard.connectHost', 'Connect')
      )}
    </Button>
  )
}

// fork-comment-ok: same click contract as Connect — the row must not commit when its action does.
/** A row's inline next step. */
export function RowTextAction({
  label,
  ariaLabel,
  disabled = false,
  onClick
}: {
  label: string
  ariaLabel?: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      className="ml-1 shrink-0 self-center"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      {label}
    </Button>
  )
}

export function CloneProgressLabel(): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1 self-center text-xs text-muted-foreground">
      <LoaderCircle className="size-3 animate-spin" />
      {t('auto.components.NewWorkspaceComposerCard.cloning', 'Cloning…')}
    </span>
  )
}
