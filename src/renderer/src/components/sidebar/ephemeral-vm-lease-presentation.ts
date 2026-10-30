import type { EphemeralVmRuntimeLease } from '@/hooks/useEphemeralVmRuntimes'
import { isReleasedEphemeralVmRuntime } from '@/hooks/useEphemeralVmRuntimes'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { formatEphemeralVmRemaining } from '../../../../shared/ephemeral-vm-lifetime'

/** Inside the last hour of a lease is when the chip earns its destructive tone. */
export const EPHEMERAL_VM_LEASE_WARNING_MS = 60 * 60 * 1000

const DEADLINE_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/** The provider's own instant, for a tooltip or a toast about a lease. */
export function formatEphemeralVmDeadline(releaseAtMs: number): string {
  return uiDateTimeFormat(DEADLINE_OPTIONS).format(new Date(releaseAtMs))
}

export { isReleasedEphemeralVmRuntime }

export type EphemeralVmLeaseIndicator = {
  expired: boolean
  /** Coarse `3h` / `11m`. Floored, so it never overstates the time left. */
  remaining: string
  tone: 'muted' | 'destructive'
  releaseAtMs: number
  provider: string | null
}

/** What a workspace shows for a lease, or null when there is no lease to show. */
export function resolveEphemeralVmLeaseIndicator(
  lease: EphemeralVmRuntimeLease | null
): EphemeralVmLeaseIndicator | null {
  // Why: no host, a released host, or a recipe that published no deadline has nothing to count down.
  if (!lease?.lifetime || isReleasedEphemeralVmRuntime(lease.runtime)) {
    return null
  }
  return {
    expired: lease.expired,
    remaining: formatEphemeralVmRemaining(lease.remainingMs),
    tone:
      lease.expired || lease.remainingMs < EPHEMERAL_VM_LEASE_WARNING_MS ? 'destructive' : 'muted',
    releaseAtMs: lease.lifetime.releaseAtMs,
    provider: lease.lifetime.provider ?? null
  }
}
