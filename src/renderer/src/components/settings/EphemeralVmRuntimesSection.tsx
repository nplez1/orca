import { Loader2, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { parseEphemeralVmLifetimeDuration } from '../../../../shared/ephemeral-vm-lifetime'
import { EPHEMERAL_VM_CLEANUP_STOPPED_ERROR } from '../../../../shared/ephemeral-vm-recipe-destroy-result'
import {
  isEphemeralVmHostActionable,
  refreshEphemeralVmRuntimes,
  resolveEphemeralVmRuntimeLease
} from '@/hooks/useEphemeralVmRuntimes'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { ephemeralVmCleanupErrorText } from '@/lib/ephemeral-vm-error-copy'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { EphemeralVmCleanupStopDialog } from './EphemeralVmCleanupStopDialog'
import { EphemeralVmRuntimeRow, formatEphemeralVmLeaseDeadline } from './EphemeralVmRuntimeRow'
import { CloudVmSetupGuide } from './CloudVmSetupGuide'

function hasCleanupFailed(runtime: EphemeralVmRuntimeRecord): boolean {
  return (
    runtime.cleanupStatus === 'failed' ||
    runtime.status === 'cleanup_failed' ||
    (runtime.status === 'cleaned' && runtime.sshTargetId !== undefined)
  )
}

function isCleanupRunning(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.cleanupStatus === 'running' || runtime.status === 'cleanup_pending'
}

function hasCleanupStopped(runtime: EphemeralVmRuntimeRecord): boolean {
  return (
    runtime.cleanupStatus === 'failed' &&
    runtime.cleanupLastError === EPHEMERAL_VM_CLEANUP_STOPPED_ERROR
  )
}

export function getVisibleEphemeralVmRuntimes(
  runtimes: readonly EphemeralVmRuntimeRecord[]
): EphemeralVmRuntimeRecord[] {
  return runtimes
    .filter((runtime) => runtime.status !== 'cleaned' || runtime.sshTargetId !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

/**
 * The lifetimes this runtime's provider sells, or none when it cannot be extended.
 *
 * Why the runtime's own snapshot: a later edit to the recipe pack must not offer a lifetime this
 * runtime was never created with. Why nothing once the host is released or reclaimed: main refuses
 * that extension, so offering it would only produce an action that always fails.
 */
export function getEphemeralVmExtendDurations(runtime: EphemeralVmRuntimeRecord): string[] {
  // Why the shared predicate: "this host cannot take an action" is the same question the lease chip,
  // the context menu and main's refusal all ask, and it covers reclaimed, cleaned, released, and a
  // teardown that already started.
  if (!runtime.extend || !isEphemeralVmHostActionable(runtime)) {
    return []
  }
  return (runtime.extendDurations ?? []).filter(
    (duration) => parseEphemeralVmLifetimeDuration(duration) !== null
  )
}

/**
 * The deadline a successful extension reported, or null when the provider reported none.
 *
 * Why module scope: the clock has to be read outside render, where an impure call is the caller's.
 */
function getExtendedEphemeralVmLeaseDeadline(runtime: EphemeralVmRuntimeRecord): number | null {
  return resolveEphemeralVmRuntimeLease(runtime, Date.now())?.lifetime?.releaseAtMs ?? null
}

export function getEphemeralVmRuntimeStatusLabel(runtime: EphemeralVmRuntimeRecord): string {
  if (hasCleanupStopped(runtime)) {
    return translate(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupStopped',
      'Cleanup stopped'
    )
  }
  if (hasCleanupFailed(runtime)) {
    return translate(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupFailed',
      'Cleanup failed'
    )
  }
  if (runtime.cleanupStatus === 'running' || runtime.status === 'cleanup_pending') {
    return translate(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupRunning',
      'Cleanup running'
    )
  }
  if (runtime.cleanupStatus === 'disabled') {
    return translate(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupDisabled',
      'Cleanup disabled'
    )
  }
  if (runtime.status === 'running') {
    return translate('auto.components.settings.EphemeralVmRuntimesSection.running', 'Running')
  }
  if (runtime.status === 'failed') {
    return translate('auto.components.settings.EphemeralVmRuntimesSection.failed', 'Failed')
  }
  return runtime.status
}

export function EphemeralVmRuntimesSection(): React.JSX.Element | null {
  const [runtimes, setRuntimes] = useState<EphemeralVmRuntimeRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [cleaningId, setCleaningId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [extending, setExtending] = useState<{ runtimeId: string; lifetime: string } | null>(null)
  const [pendingStop, setPendingStop] = useState<EphemeralVmRuntimeRecord | null>(null)
  const mountedRef = useMountedRef()

  const refresh = useCallback(
    async (showLoading = true, reportError = true): Promise<void> => {
      if (mountedRef.current && showLoading) {
        setIsLoading(true)
      }
      try {
        const nextRuntimes = await window.api.ephemeralVm.listRuntimes()
        if (mountedRef.current) {
          setRuntimes(getVisibleEphemeralVmRuntimes(nextRuntimes))
        }
      } catch (error) {
        if (mountedRef.current && reportError) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.cloudVmLoadFailed',
                  'Couldn’t load Cloud VM runtimes.'
                )
          )
        }
      } finally {
        if (mountedRef.current && showLoading) {
          setIsLoading(false)
        }
      }
    },
    [mountedRef]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const hasRunningCleanup = runtimes.some(isCleanupRunning) || cleaningId !== null
  useEffect(() => {
    if (!hasRunningCleanup) {
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      await refresh(false, false)
      if (!cancelled) {
        timer = setTimeout(() => void poll(), 1_000)
      }
    }
    timer = setTimeout(() => void poll(), 1_000)
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [hasRunningCleanup, refresh])

  const cleanupRuntime = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    setCleaningId(runtime.id)
    try {
      const cleaned = await window.api.ephemeralVm.cleanup({ runtimeId: runtime.id })
      if (hasCleanupStopped(cleaned)) {
        await refresh(false)
        return
      }
      if (hasCleanupFailed(cleaned)) {
        throw new Error(
          ephemeralVmCleanupErrorText(cleaned) ??
            translate(
              'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleanupFailedToast',
              'Couldn’t clean up Cloud VM runtime.'
            )
        )
      }
      if (mountedRef.current) {
        toast.success(
          cleaned.cleanupStatus === 'disabled'
            ? translate(
                'auto.components.settings.EphemeralVmRuntimesSection.cloudVmMarkedCleaned',
                'Marked Cloud VM runtime as cleaned.'
              )
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleaned',
                'Cleaned up Cloud VM runtime.'
              )
        )
      }
      await refresh()
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleanupFailedToast',
                'Couldn’t clean up Cloud VM runtime.'
              )
        )
        await refresh()
      }
    } finally {
      if (mountedRef.current) {
        setCleaningId(null)
      }
      // Why: a released host must stop advertising a deadline on every surface that reads the cache.
      void refreshEphemeralVmRuntimes()
    }
  }

  const extendLifetime = async (
    runtime: EphemeralVmRuntimeRecord,
    lifetime: string
  ): Promise<void> => {
    setExtending({ runtimeId: runtime.id, lifetime })
    try {
      const extended = await window.api.ephemeralVm.extendLifetime({
        runtimeId: runtime.id,
        lifetime
      })
      if (mountedRef.current) {
        const extendedDeadlineMs = getExtendedEphemeralVmLeaseDeadline(extended)
        toast.success(
          extendedDeadlineMs !== null
            ? translate(
                'auto.components.settings.EphemeralVmRuntimesSection.leaseExtendedUntil',
                'Lease extended to {{value0}}.',
                { value0: formatEphemeralVmLeaseDeadline(extendedDeadlineMs) }
              )
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.leaseExtended',
                'Lease extended.'
              )
        )
      }
      await refresh(false)
      // Why also the shared cache: the workspace card and the host list read the deadline there.
      await refreshEphemeralVmRuntimes()
    } catch (error) {
      // Why no refresh on failure: main leaves the record untouched, so the deadline did not move.
      // Why the provider's own words: only its message says whether a retry could succeed.
      if (mountedRef.current) {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) {
        setExtending(null)
      }
    }
  }

  const copyCleanupCommand = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    try {
      const result = await window.api.ephemeralVm.getCleanupCommand({ runtimeId: runtime.id })
      const text = result.command
        ? `${result.command}\n\n# Cleanup payload:\n${result.payloadJson}`
        : result.payloadJson
      await window.api.ui.writeClipboardText(text)
      if (mountedRef.current) {
        toast.success(
          result.command
            ? translate(
                'auto.components.settings.EphemeralVmRuntimesSection.copiedCleanupCommand',
                'Copied cleanup command.'
              )
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.copiedCleanupPayload',
                'Copied cleanup payload.'
              )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.copyCleanupFailed',
                'Couldn’t copy cleanup command.'
              )
        )
      }
    }
  }

  const stopCleanup = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    setStoppingId(runtime.id)
    try {
      await window.api.ephemeralVm.stopCleanup({ runtimeId: runtime.id })
      if (mountedRef.current) {
        setPendingStop(null)
        await refresh(false)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.EphemeralVmRuntimesSection.stopCleanupFailed',
                'Couldn’t stop Cloud VM cleanup.'
              )
        )
        await refresh(false)
      }
    } finally {
      if (mountedRef.current) {
        setStoppingId(null)
      }
      void refreshEphemeralVmRuntimes()
    }
  }

  const hasRuntimes = runtimes.length > 0
  if (!hasRuntimes) {
    return null
  }
  return (
    <section
      className="scroll-mt-8 rounded-lg border border-border bg-card"
      data-settings-section="temporary-vm-runtimes"
    >
      <CloudVmSetupGuide
        refreshAction={
          hasRuntimes ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.settings.EphemeralVmRuntimesSection.cloudVmRefresh',
                    'Refresh Cloud VM runtimes'
                  )}
                  onClick={() => void refresh()}
                  disabled={isLoading || cleaningId !== null}
                >
                  {isLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.cloudVmRefreshLabel',
                  'Refresh Cloud VMs'
                )}
              </TooltipContent>
            </Tooltip>
          ) : null
        }
      />
      {hasRuntimes ? (
        <div className="divide-y divide-border border-t border-border">
          {runtimes.map((runtime) => (
            <EphemeralVmRuntimeRow
              key={runtime.id}
              runtime={runtime}
              statusLabel={getEphemeralVmRuntimeStatusLabel(runtime)}
              cleanupFailed={hasCleanupFailed(runtime)}
              cleanupRunning={isCleanupRunning(runtime) || cleaningId === runtime.id}
              isStopping={stoppingId === runtime.id}
              disabled={
                isLoading ||
                (cleaningId !== null && cleaningId !== runtime.id) ||
                (stoppingId !== null && stoppingId !== runtime.id) ||
                (extending !== null && extending.runtimeId !== runtime.id)
              }
              onCleanup={() => void cleanupRuntime(runtime)}
              onStopCleanup={() => setPendingStop(runtime)}
              onCopyCleanupCommand={() => void copyCleanupCommand(runtime)}
              extendDurations={getEphemeralVmExtendDurations(runtime)}
              extendingLifetime={
                extending !== null && extending.runtimeId === runtime.id ? extending.lifetime : null
              }
              onExtendLifetime={(lifetime) => void extendLifetime(runtime, lifetime)}
            />
          ))}
        </div>
      ) : null}
      <EphemeralVmCleanupStopDialog
        runtime={pendingStop}
        isStopping={stoppingId !== null}
        onCancel={() => setPendingStop(null)}
        onConfirm={() => {
          if (pendingStop) {
            void stopCleanup(pendingStop)
          }
        }}
      />
    </section>
  )
}
