import { runAsyncTaskWithFailure } from '@/lib/async-task-with-cleanup'
import { Loader2, RefreshCw } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import { refreshEphemeralVmRuntimes } from '@/hooks/useEphemeralVmRuntimes'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { ephemeralVmCleanupErrorText } from '@/lib/ephemeral-vm-error-copy'
import { Button } from '../../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { EphemeralVmCleanupStopDialog } from './EphemeralVmCleanupStopDialog'
import { EphemeralVmRuntimeRow, formatEphemeralVmLeaseDeadline } from './EphemeralVmRuntimeRow'
import { CloudVmSetupGuide } from './CloudVmSetupGuide'
import {
  getEphemeralVmExtendDurations,
  getEphemeralVmRuntimeStatusLabel,
  getExtendedEphemeralVmLeaseDeadline,
  getVisibleEphemeralVmRuntimes,
  hasCleanupFailed,
  hasCleanupStopped,
  isCleanupRunning
} from './ephemeral-vm-runtimes-section-state'

export function EphemeralVmRuntimesSection(): React.JSX.Element | null {
  const t = useTranslate()
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
      await runAsyncTaskWithFailure(
        async () => {
          const nextRuntimes = await window.api.ephemeralVm.listRuntimes()
          if (mountedRef.current) {
            setRuntimes(getVisibleEphemeralVmRuntimes(nextRuntimes))
          }
        },
        async (error) => {
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
        },
        () => {
          if (mountedRef.current && showLoading) {
            setIsLoading(false)
          }
        }
      )
    },
    [mountedRef]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const hasRunningLifecycle =
    runtimes.some((runtime) => isCleanupRunning(runtime) || runtime.status === 'provisioning') ||
    cleaningId !== null
  useEffect(() => {
    if (!hasRunningLifecycle) {
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
  }, [hasRunningLifecycle, refresh])

  const cleanupRuntime = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    setCleaningId(runtime.id)
    await runAsyncTaskWithFailure(
      async () => {
        const cleaned = await window.api.ephemeralVm.cleanup({ runtimeId: runtime.id })
        if (hasCleanupStopped(cleaned)) {
          await refresh(false)
          return
        }
        if (hasCleanupFailed(cleaned)) {
          throw new Error(
            ephemeralVmCleanupErrorText(cleaned) ??
              t(
                'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleanupFailedToast',
                'Couldn’t clean up Cloud VM runtime.'
              )
          )
        }
        if (mountedRef.current) {
          toast.success(
            cleaned.cleanupStatus === 'disabled'
              ? t(
                  'auto.components.settings.EphemeralVmRuntimesSection.cloudVmMarkedCleaned',
                  'Marked Cloud VM runtime as cleaned.'
                )
              : t(
                  'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleaned',
                  'Cleaned up Cloud VM runtime.'
                )
          )
        }
        await refresh()
      },
      async (error) => {
        if (mountedRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : t(
                  'auto.components.settings.EphemeralVmRuntimesSection.cloudVmCleanupFailedToast',
                  'Couldn’t clean up Cloud VM runtime.'
                )
          )
          await refresh()
        }
      },
      () => {
        if (mountedRef.current) {
          setCleaningId(null)
        }
        // Why: a released host must stop advertising a deadline on every surface that reads the cache.
        void refreshEphemeralVmRuntimes()
      }
    )
  }

  const extendLifetime = async (
    runtime: EphemeralVmRuntimeRecord,
    lifetime: string
  ): Promise<void> => {
    setExtending({ runtimeId: runtime.id, lifetime })
    await runAsyncTaskWithFailure(
      async () => {
        const extended = await window.api.ephemeralVm.extendLifetime({
          runtimeId: runtime.id,
          lifetime
        })
        if (mountedRef.current) {
          const extendedDeadlineMs = getExtendedEphemeralVmLeaseDeadline(extended)
          toast.success(
            extendedDeadlineMs !== null
              ? t(
                  'auto.components.settings.EphemeralVmRuntimesSection.leaseExtendedUntil',
                  'Lease extended to {{value0}}.',
                  { value0: formatEphemeralVmLeaseDeadline(extendedDeadlineMs) }
                )
              : t(
                  'auto.components.settings.EphemeralVmRuntimesSection.leaseExtended',
                  'Lease extended.'
                )
          )
        }
        await refresh(false)
        // Why also the shared cache: the workspace card and the host list read the deadline there.
        await refreshEphemeralVmRuntimes()
      },
      async (error) => {
        // Why no refresh on failure: main leaves the record untouched, so the deadline did not move.
        // Why the provider's own words: only its message says whether a retry could succeed.
        if (mountedRef.current) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      },
      () => {
        if (mountedRef.current) {
          setExtending(null)
        }
      }
    )
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
            ? t(
                'auto.components.settings.EphemeralVmRuntimesSection.copiedCleanupCommand',
                'Copied cleanup command.'
              )
            : t(
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
            : t(
                'auto.components.settings.EphemeralVmRuntimesSection.copyCleanupFailed',
                'Couldn’t copy cleanup command.'
              )
        )
      }
    }
  }

  const forgetRuntime = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    try {
      await window.api.ephemeralVm.forgetRuntime({ runtimeId: runtime.id })
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : t(
                'auto.components.settings.EphemeralVmRuntimesSection.removeFromListFailed',
                'Couldn’t remove Cloud VM runtime from the list.'
              )
        )
      }
    }
    await refresh(false)
  }

  const stopCleanup = async (runtime: EphemeralVmRuntimeRecord): Promise<void> => {
    setStoppingId(runtime.id)
    await runAsyncTaskWithFailure(
      async () => {
        await window.api.ephemeralVm.stopCleanup({ runtimeId: runtime.id })
        if (mountedRef.current) {
          setPendingStop(null)
          await refresh(false)
        }
      },
      async (error) => {
        if (mountedRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : t(
                  'auto.components.settings.EphemeralVmRuntimesSection.stopCleanupFailed',
                  'Couldn’t stop Cloud VM cleanup.'
                )
          )
          await refresh(false)
        }
      },
      () => {
        if (mountedRef.current) {
          setStoppingId(null)
        }
        void refreshEphemeralVmRuntimes()
      }
    )
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
                  aria-label={t(
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
                {t(
                  'auto.components.settings.EphemeralVmRuntimesSection.cca21fb369',
                  'Refresh cloud VMs'
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
              statusLabel={getEphemeralVmRuntimeStatusLabel(runtime, t)}
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
              onForget={() => void forgetRuntime(runtime)}
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
