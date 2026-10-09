import { useCallback, useRef, useState } from 'react'
import { Server } from 'lucide-react'
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  isAutoImportedSshTarget,
  type SshConnectionState,
  type SshConnectionStatus,
  type SshTarget
} from '../../../../shared/ssh-types'
import { Badge } from '../ui/badge'
import { SshTargetCardActions } from './SshTargetCardActions'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

// ── Shared status helpers ────────────────────────────────────────────

export const STATUS_LABELS: Record<SshConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting\u2026',
  'auth-failed': 'Auth failed',
  'deploying-relay': 'Deploying relay\u2026',
  connected: 'Connected',
  reconnecting: 'Reconnecting\u2026',
  'reconnection-failed': 'Reconnection failed',
  get error() {
    return translate('auto.components.settings.SshTargetCard.18968ede9e', 'Error')
  }
}

// Why separate: rung D connects without the Orca remote server, and the card must say so.
export const PLAIN_SSH_STATUS_LABEL = 'Connected (plain SSH)'

export function statusColor(status: SshConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'connecting':
    case 'deploying-relay':
    case 'reconnecting':
      return 'bg-yellow-500'
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'bg-red-500'
    case 'disconnected':
      return 'bg-muted-foreground/40'
  }
}

function formatGraceDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h`
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}m`
  }
  return `${seconds}s`
}

function formatTerminalPersistence(target: SshTarget): string {
  const graceSeconds = target.relayGracePeriodSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
  if (graceSeconds === 0) {
    return translate('auto.components.settings.SshTargetCard.8ce71262f4', 'terminals until reset')
  }
  return translate(
    'auto.components.settings.SshTargetCard.a883f5a00f',
    'terminal timeout: {{value0}}',
    { value0: formatGraceDuration(graceSeconds) }
  )
}

// ── SshTargetCard ────────────────────────────────────────────────────

type SshTargetCardProps = {
  target: SshTarget
  state: SshConnectionState | undefined
  testing: boolean
  busyAction?: SshTargetBusyAction
  /** Handlers take no target: the caller already binds this card's row. */
  onConnect: () => void | Promise<void>
  onDisconnect: () => void | Promise<void>
  onTerminateSessions: () => void | Promise<void>
  onResetRelay: () => void | Promise<void>
  onTest: () => void | Promise<void>
  onEdit: () => void
  onRemove: () => void
  onSetHidden: (hidden: boolean) => void | Promise<void>
}

export function SshTargetCard({
  target,
  state,
  testing,
  busyAction,
  onConnect,
  onDisconnect,
  onTerminateSessions,
  onResetRelay,
  onTest,
  onEdit,
  onRemove,
  onSetHidden
}: SshTargetCardProps): React.JSX.Element {
  const status: SshConnectionStatus = state?.status ?? 'disconnected'
  const [actionInFlight, setActionInFlight] = useState<
    'connect' | 'disconnect' | 'terminate' | 'reset' | null
  >(null)
  // Why: hiding is not a destructive action, so it does not join the shared busy
  // registry — but it does have to block the other buttons while it lands.
  const [visibilityInFlight, setVisibilityInFlight] = useState(false)
  const hasActionInFlight =
    actionInFlight !== null || busyAction !== undefined || visibilityInFlight
  const terminateInFlight = actionInFlight === 'terminate' || busyAction === 'terminate'
  const resetInFlight = actionInFlight === 'reset' || busyAction === 'reset'
  const removeInFlight = busyAction === 'remove'
  const hidden = target.hidden === true
  // Why: deletion cannot stick for a host ~/.ssh/config keeps re-importing, so a discovered
  // host is hidden instead. A host the user added in Orca has no such source and is removed.
  const hideable = isAutoImportedSshTarget(target)
  const mountedRef = useRef(true)
  const endpoint = target.username
    ? `${target.username}@${target.host}:${target.port}`
    : `${target.host}:${target.port}`
  const terminalPersistence = formatTerminalPersistence(target)

  const handleCardRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: SSH target actions can resolve after the card is removed; the root
    // ref gives async completions the same stale-write guard without an Effect.
    mountedRef.current = node !== null
  }, [])

  const clearActionInFlight = (): void => {
    if (mountedRef.current) {
      setActionInFlight(null)
    }
  }

  const handleConnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('connect')
    void Promise.resolve(onConnect()).finally(clearActionInFlight)
  }

  const handleDisconnect = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('disconnect')
    void Promise.resolve(onDisconnect()).finally(clearActionInFlight)
  }

  const handleTerminateSessions = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('terminate')
    void Promise.resolve(onTerminateSessions()).finally(clearActionInFlight)
  }

  const handleResetRelay = (): void => {
    if (actionInFlight) {
      return
    }
    setActionInFlight('reset')
    void Promise.resolve(onResetRelay()).finally(clearActionInFlight)
  }

  const handleSetHidden = (next: boolean): void => {
    if (hasActionInFlight) {
      return
    }
    setVisibilityInFlight(true)
    void Promise.resolve(onSetHidden(next)).finally(() => {
      if (mountedRef.current) {
        setVisibilityInFlight(false)
      }
    })
  }

  return (
    <div
      ref={handleCardRef}
      data-ssh-target-card=""
      data-ssh-target-label={target.label}
      className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-4 py-3"
    >
      <Server className="size-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{target.label}</span>
          {hidden ? (
            <Badge variant="hostContext">
              {translate('auto.components.settings.SshTargetCard.hiddenBadge', 'Hidden')}
            </Badge>
          ) : null}
          <span className={`size-2 shrink-0 rounded-full ${statusColor(status)}`} />
          <span className="text-[11px] text-muted-foreground">
            {status === 'connected' && state?.plainSsh
              ? PLAIN_SSH_STATUS_LABEL
              : STATUS_LABELS[status]}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {endpoint}
          {target.identityFile ? ` \u2022 ${target.identityFile}` : ''}
          {` \u2022 ${terminalPersistence}`}
        </p>
        {/* Why not truncate: host key failures put the remedy (`ssh-keygen -R <host>`) at the end,
            and a one-line clamp with no tooltip made it unreachable even on hover. */}
        {state?.error ? (
          <p className="mt-0.5 text-xs text-red-400 [overflow-wrap:anywhere]">{state.error}</p>
        ) : null}
        {status === 'connected' && state?.plainSsh ? (
          <p
            data-ssh-plain-reason={state.plainSsh.reason}
            className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]"
          >
            {state.plainSsh.message}
          </p>
        ) : null}
        {status === 'connected' && state?.hostNodeRuntime ? (
          <p
            data-ssh-host-node-runtime=""
            className="mt-0.5 text-xs text-status-warning [overflow-wrap:anywhere]"
          >
            {/* Why two: only an opt-in can be undone in settings; Auto lands here when Orca-managed Node couldn't run. */}
            {target.remoteRuntime === 'legacy'
              ? translate(
                  'auto.components.settings.SshTargetCard.hostNodeUnsupported',
                  'Unsupported configuration: Orca runs on this host’s Node.js with terminal support installed by npm on the host. Set Runtime to Auto in this host’s SSH settings to use Orca-managed Node.'
                )
              : translate(
                  'auto.components.settings.SshTargetCard.hostNodeFallback',
                  'Unsupported configuration: Orca-managed Node isn’t available for this connection, so Orca runs on this host’s Node.js with terminal support installed by npm on the host.'
                )}
          </p>
        ) : null}
      </div>

      <SshTargetCardActions
        status={status}
        testing={testing}
        actionInFlight={actionInFlight}
        hasActionInFlight={hasActionInFlight}
        terminateInFlight={terminateInFlight}
        resetInFlight={resetInFlight}
        removeInFlight={removeInFlight}
        hidden={hidden}
        hideable={hideable}
        visibilityInFlight={visibilityInFlight}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onTerminateSessions={handleTerminateSessions}
        onResetRelay={handleResetRelay}
        onTest={() => onTest()}
        onEdit={onEdit}
        onRemove={onRemove}
        onSetHidden={handleSetHidden}
      />
    </div>
  )
}
