import React, { useMemo } from 'react'
import { AlertTriangle, ChevronDown, Loader2, Server, ServerOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { formatEphemeralVmRemaining } from '../../../../../../shared/ephemeral-vm-lifetime'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import {
  isReleasedEphemeralVmRuntime,
  resolveEphemeralVmRuntimeLease,
  useEphemeralVmRuntimes
} from '@/hooks/useEphemeralVmRuntimes'
import { useSecondTickNow } from '../../prompt-cache-countdown-clock'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { HostSectionHeaderMenu } from '../../HostSectionHeaderMenu'
import { stopRepoHeaderMenuEvent } from './header-event-guards'
import { getHostHeaderDetail } from './host-header-detail'

/** How long one ephemeral host has left, as its header shows it. */
export type EphemeralHostLease = {
  expired: boolean
  /** Coarse `3h` / `11m`, floored so it never overstates what is left. */
  remaining: string
}

/**
 * The host a runtime's workspace runs on. Both spellings are real: `runtime:<env>` when the recipe
 * connected through an Orca server, and `ssh:<target>` for a recipe that only gives an SSH host.
 */
function getEphemeralVmHostId(runtime: EphemeralVmRuntimeRecord): ExecutionHostId | null {
  if (runtime.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(runtime.runtimeEnvironmentId)
  }
  return runtime.sshTargetId ? toSshExecutionHostId(runtime.sshTargetId) : null
}

/**
 * What one host header shows for its lease, or null when that host is not on a provider lease.
 *
 * Why the records are searched rather than the runtime read off the row: a host header is keyed by
 * host id, and only the runtime's own connection fields say which host it is.
 */
export function resolveEphemeralHostLease(
  records: readonly EphemeralVmRuntimeRecord[],
  hostId: ExecutionHostId,
  nowMs: number
): EphemeralHostLease | null {
  const runtime =
    records.find(
      (record) => getEphemeralVmHostId(record) === hostId && !isReleasedEphemeralVmRuntime(record)
    ) ?? null
  const lease = resolveEphemeralVmRuntimeLease(runtime, nowMs)
  return lease?.lifetime
    ? { expired: lease.expired, remaining: formatEphemeralVmRemaining(lease.remainingMs) }
    : null
}

/**
 * The lease behind one host header.
 *
 * Why the records are read before the clock: only a host with a deadline needs the 1s tick, and only
 * this marker subscribes to it, so no other part of the header re-renders for it.
 */
function useHostEphemeralLease(hostId: ExecutionHostId): EphemeralHostLease | null {
  const records = useEphemeralVmRuntimes()
  const hasLease = useMemo(
    () => resolveEphemeralHostLease(records, hostId, 0) !== null,
    [hostId, records]
  )
  const nowMs = useSecondTickNow(hasLease)
  return useMemo(() => resolveEphemeralHostLease(records, hostId, nowMs), [hostId, nowMs, records])
}

/** `Exp 3h` for a host on a provider lease, `Expired` once that deadline has passed. */
function EphemeralHostLeaseMarker({
  hostId
}: {
  hostId: ExecutionHostId
}): React.JSX.Element | null {
  const lease = useHostEphemeralLease(hostId)
  if (!lease) {
    return null
  }
  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 text-[9px] font-medium leading-none',
        lease.expired
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-worktree-sidebar-border bg-worktree-sidebar-accent text-muted-foreground/90'
      )}
    >
      {lease.expired
        ? translate('auto.components.sidebar.WorktreeList.ephemeralLeaseExpired', 'Expired')
        : translate(
            'auto.components.sidebar.WorktreeList.ephemeralLeaseRemaining',
            'Exp {{value0}}',
            { value0: lease.remaining }
          )}
    </span>
  )
}

function SectionMetricsBadge({ count }: { count: number }): React.JSX.Element {
  const totalLabel = translate(
    'auto.components.sidebar.HostSectionHeader.workspaceCount',
    '{{count}} workspaces',
    { count, defaultValue_one: '{{count}} workspace' }
  )

  return (
    <span
      className="inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90"
      aria-label={totalLabel}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full min-w-4 items-center justify-center px-1.5">
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {totalLabel}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function HostHeaderHealthIcon({
  health
}: {
  health: HostHeaderRow['health']
}): React.JSX.Element | null {
  // Why: only surface states needing attention; healthy is the silent default.
  if (health === 'connecting') {
    return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  }
  if (health === 'blocked' || health === 'error') {
    return <AlertTriangle className="size-3 shrink-0 text-destructive" />
  }
  return null
}

export function HostSectionHeader({
  row,
  onToggle,
  onDragPointerDown,
  dragging
}: {
  row: HostHeaderRow
  onToggle: () => void
  onDragPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
  dragging?: boolean
}): React.JSX.Element {
  const isBlocked = row.health === 'blocked'
  const isDisconnected = row.health === 'disconnected'
  const detail = getHostHeaderDetail(row)
  return (
    <div className="px-2 pt-1">
      {/* Why: outlined card + server glyph marks hosts as machines, not mere groups. */}
      <div
        role="button"
        tabIndex={0}
        data-host-header-drag-id={row.hostId}
        aria-expanded={!row.collapsed}
        className={cn(
          'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-all',
          onDragPointerDown && 'cursor-grab active:cursor-grabbing',
          isBlocked
            ? 'border-destructive/40 bg-destructive/10'
            : isDisconnected
              ? 'border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35 text-muted-foreground'
              : 'border-worktree-sidebar-border bg-worktree-sidebar-accent/70',
          dragging && 'pointer-events-none opacity-0'
        )}
        onPointerDown={onDragPointerDown}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        {isDisconnected ? (
          <ServerOff className="size-3.5 shrink-0 text-muted-foreground/80" />
        ) : (
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <HostHeaderHealthIcon health={row.health} />
        {/* Why: badge hugs the label (like repo headers) instead of floating by the hover controls. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate text-[12px] font-semibold leading-none',
              isDisconnected ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {row.label}
          </span>
          <EphemeralHostLeaseMarker hostId={row.hostId} />
          {detail ? (
            <span
              className={cn(
                'shrink-0 truncate text-[10px] leading-none',
                detail.isWarning ? 'text-destructive' : 'text-muted-foreground/70'
              )}
            >
              {detail.text}
            </span>
          ) : null}
          <SectionMetricsBadge count={row.count} />
        </div>
        <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 can-hover:opacity-0 transition-opacity group-hover/host-header:opacity-100">
          <ChevronDown
            className={cn('size-3.5 transition-transform', row.collapsed && '-rotate-90')}
          />
        </div>
        {/* Why: menu and dialog portals still bubble React events here; keep them from toggling or dragging the row. */}
        <span
          data-host-header-action=""
          className="flex shrink-0 items-center"
          onPointerDown={stopRepoHeaderMenuEvent}
          onMouseDown={stopRepoHeaderMenuEvent}
          onPointerUp={stopRepoHeaderMenuEvent}
          onMouseUp={stopRepoHeaderMenuEvent}
          onClick={stopRepoHeaderMenuEvent}
          onKeyDown={stopRepoHeaderMenuEvent}
        >
          <HostSectionHeaderMenu row={row} />
        </span>
      </div>
    </div>
  )
}
