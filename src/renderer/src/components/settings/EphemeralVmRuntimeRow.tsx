import { useMemo } from 'react'
import { AlertTriangle, CalendarClock, Copy, Loader2, Square, Trash2, Unplug } from 'lucide-react'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultProjectRoot } from '../../../../shared/ephemeral-vm-recipes'
import { formatEphemeralVmCountdown } from '../../../../shared/ephemeral-vm-lifetime'
import { useSecondTickNow } from '@/components/sidebar/prompt-cache-countdown-clock'
import { resolveEphemeralVmRuntimeLease } from '@/hooks/useEphemeralVmRuntimes'
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { ephemeralVmCleanupErrorText } from '@/lib/ephemeral-vm-error-copy'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

const LEASE_DEADLINE_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short'
}

/** The provider's own instant, for the row's deadline line and the extension confirmation. */
export function formatEphemeralVmLeaseDeadline(releaseAtMs: number): string {
  return uiDateTimeFormat(LEASE_DEADLINE_OPTIONS).format(new Date(releaseAtMs))
}

/**
 * The provider's deadline and how long is left of it.
 *
 * Why the deadline is read before the clock: only a host with a provider deadline needs the 1s
 * tick, and only this leaf subscribes to it, so the rest of the row never re-renders for it.
 */
function EphemeralVmLeaseStatus({
  runtime
}: {
  runtime: EphemeralVmRuntimeRecord
}): React.JSX.Element | null {
  const hasDeadline = useMemo(
    () => Boolean(resolveEphemeralVmRuntimeLease(runtime, 0)?.lifetime),
    [runtime]
  )
  const nowMs = useSecondTickNow(hasDeadline)
  const lease = resolveEphemeralVmRuntimeLease(runtime, nowMs)
  const lifetime = lease?.lifetime
  // Why this precedes the lease line: a reclaimed record still carries its old deadline, so showing
  // a countdown for it would describe a host Orca has already released.
  if (runtime.reclaimedAt !== undefined) {
    return (
      <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
        <Unplug className="mt-px size-3 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.EphemeralVmRuntimesSection.reclaimedHost',
            'Released from Orca on {{value0}}: this host stopped answering after its provider deadline, so its workspace rows were removed. The provider still owns the resource — Cleanup releases it now.',
            { value0: formatEphemeralVmLeaseDeadline(runtime.reclaimedAt) }
          )}
        </span>
      </p>
    )
  }
  if (!lease || !lifetime) {
    return null
  }
  const deadline = formatEphemeralVmLeaseDeadline(lifetime.releaseAtMs)
  if (lease.expired) {
    return (
      <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-destructive">
        <AlertTriangle className="mt-px size-3 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.EphemeralVmRuntimesSection.leaseExpired',
            'Lease expired {{value0}}. The provider can remove this host at any time, including while Orca is offline.',
            { value0: deadline }
          )}
        </span>
      </p>
    )
  }
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-snug text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="size-3 shrink-0" />
        {translate(
          'auto.components.settings.EphemeralVmRuntimesSection.providerDeadline',
          'Provider deadline {{value0}}',
          { value0: deadline }
        )}
      </span>
      {lifetime.provider ? (
        <span>
          {translate(
            'auto.components.settings.EphemeralVmRuntimesSection.leaseProvider',
            'Provider: {{value0}}',
            { value0: lifetime.provider }
          )}
        </span>
      ) : null}
      <span className="tabular-nums font-medium text-foreground">
        {translate(
          'auto.components.settings.EphemeralVmRuntimesSection.leaseRemaining',
          '{{value0}} left',
          { value0: formatEphemeralVmCountdown(lease.remainingMs) }
        )}
      </span>
    </p>
  )
}

type EphemeralVmRuntimeRowProps = {
  runtime: EphemeralVmRuntimeRecord
  statusLabel: string
  cleanupFailed: boolean
  cleanupRunning: boolean
  isStopping: boolean
  disabled: boolean
  /** The lifetimes the provider sells; empty hides the Extend lifetime action. */
  extendDurations: readonly string[]
  /** The lifetime an extension is currently buying, so the row can show it is in flight. */
  extendingLifetime: string | null
  onCleanup: () => void
  onStopCleanup: () => void
  onCopyCleanupCommand: () => void
  onExtendLifetime: (lifetime: string) => void
}

export function EphemeralVmRuntimeRow({
  runtime,
  statusLabel,
  cleanupFailed,
  cleanupRunning,
  isStopping,
  disabled,
  extendDurations,
  extendingLifetime,
  onCleanup,
  onStopCleanup,
  onCopyCleanupCommand,
  onExtendLifetime
}: EphemeralVmRuntimeRowProps): React.JSX.Element {
  const hasError = cleanupFailed || runtime.status === 'failed'
  const isExtending = extendingLifetime !== null
  const cleanupError = ephemeralVmCleanupErrorText(runtime)
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div
        className={cn(
          'size-2 shrink-0 rounded-full',
          hasError ? 'bg-destructive' : 'bg-muted-foreground/40'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">
            {runtime.workspaceName || runtime.recipeId}
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
          {hasError ? <AlertTriangle className="size-3.5 shrink-0 text-destructive" /> : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {runtime.recipeId} · {getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)}
        </p>
        <EphemeralVmLeaseStatus runtime={runtime} />
        {cleanupError ? (
          // Why no truncation: for a reclaimed host this retained record is the only account of what
          // went wrong, so a reader has to be able to read all of it.
          <p className="mt-0.5 text-[11px] leading-snug break-words text-destructive">
            {cleanupError}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {extendDurations.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                // Why disabled while extending: the trigger carries the in-flight label, so the
                // row says what is happening even after the duration menu closes.
                disabled={disabled || isExtending}
              >
                {isExtending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <CalendarClock className="size-3" />
                )}
                {isExtending
                  ? translate(
                      'auto.components.settings.EphemeralVmRuntimesSection.extending',
                      'Extending…'
                    )
                  : translate(
                      'auto.components.settings.EphemeralVmRuntimesSection.extendLifetime',
                      'Extend lifetime'
                    )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {extendDurations.map((duration) => (
                <DropdownMenuItem
                  key={duration}
                  disabled={disabled || isExtending}
                  onSelect={() => onExtendLifetime(duration)}
                >
                  {translate(
                    'auto.components.settings.EphemeralVmRuntimesSection.extendTo',
                    'Extend to {{value0}}',
                    { value0: duration }
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {runtime.cleanupStatus === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onCopyCleanupCommand}
            disabled={disabled}
          >
            <Copy className="size-3" />
            {translate(
              'auto.components.settings.EphemeralVmRuntimesSection.copyCleanup',
              'Copy command'
            )}
          </Button>
        ) : null}
        {cleanupRunning ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onStopCleanup}
            disabled={disabled || isStopping}
          >
            {isStopping ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-3" />
            )}
            {isStopping
              ? translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.stoppingCleanup',
                  'Stopping…'
                )
              : translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.stopCleanup',
                  'Stop cleanup'
                )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onCleanup}
            disabled={disabled}
          >
            <Trash2 className="size-3" />
            {cleanupFailed
              ? translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.retry',
                  'Retry cleanup'
                )
              : translate('auto.components.settings.EphemeralVmRuntimesSection.cleanup', 'Cleanup')}
          </Button>
        )}
      </div>
    </div>
  )
}
