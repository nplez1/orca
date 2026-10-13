import { useCallback, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  findEphemeralVmRuntimeForWorkspace,
  refreshEphemeralVmRuntimes,
  useEphemeralVmRuntimes
} from '@/hooks/useEphemeralVmRuntimes'
import { translate } from '@/i18n/i18n'
import { readEphemeralVmLifetime } from '../../../../shared/ephemeral-vm-lifetime'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import {
  formatEphemeralVmDeadline,
  isReleasedEphemeralVmRuntime
} from './ephemeral-vm-lease-presentation'

function describeExtendSuccess(runtime: EphemeralVmRuntimeRecord): string {
  const read = readEphemeralVmLifetime(runtime.recipeResult.userData)
  if (!read.ok || !read.lifetime) {
    return translate(
      'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extended',
      'Lease extended'
    )
  }
  return translate(
    'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extendedUntil',
    'Lease extended to {{value0}}',
    { value0: formatEphemeralVmDeadline(read.lifetime.releaseAtMs) }
  )
}

/**
 * "Extend lifetime" for a workspace whose host runs on a provider lease.
 *
 * Why only the durations the recipe declared: those are the lifetimes the provider sells, so
 * anything else would be a request it rejects.
 */
export function EphemeralVmExtendLifetimeMenu({
  workspaceId,
  disabled
}: {
  workspaceId: string
  disabled: boolean
}): React.JSX.Element | null {
  const records = useEphemeralVmRuntimes()
  const runtime = findEphemeralVmRuntimeForWorkspace(records, workspaceId)
  const [pendingLifetime, setPendingLifetime] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  const handleExtend = useCallback(
    async (lifetime: string): Promise<void> => {
      if (!runtime) {
        return
      }
      setPendingLifetime(lifetime)
      try {
        const extended = await window.api.ephemeralVm.extendLifetime({
          runtimeId: runtime.id,
          lifetime
        })
        toast.success(describeExtendSuccess(extended))
        // Why: a successful extension can have re-addressed the host, so the cached records are stale.
        await refreshEphemeralVmRuntimes()
      } catch (cause) {
        // Why verbatim: only the provider's own message says whether a retry could succeed.
        toast.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (mountedRef.current) {
          setPendingLifetime(null)
        }
      }
    },
    [mountedRef, runtime]
  )

  const durations = runtime?.extend ? (runtime.extendDurations ?? []) : []
  // Why hide it on a released host: main refuses that extension outright, so offering it could only fail.
  if (!runtime?.extend || durations.length === 0 || isReleasedEphemeralVmRuntime(runtime)) {
    return null
  }

  const pending = pendingLifetime !== null
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled || pending}>
        <CalendarClock className="size-3.5" />
        {pending
          ? translate(
              'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extending',
              'Extending…'
            )
          : translate(
              'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extendLifetime',
              'Extend lifetime'
            )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        {durations.map((duration) => (
          <DropdownMenuItem
            key={duration}
            disabled={disabled || pending}
            onSelect={() => void handleExtend(duration)}
          >
            {pendingLifetime === duration
              ? translate(
                  'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extending',
                  'Extending…'
                )
              : translate(
                  'auto.components.sidebar.EphemeralVmExtendLifetimeMenu.extendTo',
                  'Extend to {{value0}}',
                  { value0: duration }
                )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
