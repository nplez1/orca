import { useMemo } from 'react'
import {
  findEphemeralVmRuntimeForWorkspace,
  resolveEphemeralVmRuntimeLease,
  useEphemeralVmRuntimes,
  type EphemeralVmRuntimeLease
} from '@/hooks/useEphemeralVmRuntimes'
import { useSecondTickNow } from './prompt-cache-countdown-clock'

/**
 * The lease for one workspace card.
 *
 * Why the record is read before the clock: only a host with a deadline needs the 1s tick, and the
 * record is what says whether this one has one.
 */
export function useWorktreeCardEphemeralLease(
  workspaceId: string | undefined
): EphemeralVmRuntimeLease | null {
  const records = useEphemeralVmRuntimes()
  const runtime = useMemo(
    () => findEphemeralVmRuntimeForWorkspace(records, workspaceId),
    [records, workspaceId]
  )
  const hasDeadline = useMemo(
    () => Boolean(resolveEphemeralVmRuntimeLease(runtime, 0)?.lifetime),
    [runtime]
  )
  const nowMs = useSecondTickNow(hasDeadline)
  return useMemo(() => resolveEphemeralVmRuntimeLease(runtime, nowMs), [runtime, nowMs])
}
