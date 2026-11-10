import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import { parseEphemeralVmLifetimeDuration } from '../../../../../../shared/ephemeral-vm-lifetime'
import { EPHEMERAL_VM_CLEANUP_STOPPED_ERROR } from '../../../../../../shared/ephemeral-vm-recipe-destroy-result'
import {
  isEphemeralVmHostActionable,
  resolveEphemeralVmRuntimeLease
} from '@/hooks/useEphemeralVmRuntimes'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function hasCleanupFailed(runtime: EphemeralVmRuntimeRecord): boolean {
  return (
    runtime.cleanupStatus === 'failed' ||
    runtime.status === 'cleanup_failed' ||
    (runtime.status === 'cleaned' && runtime.sshTargetId !== undefined)
  )
}

export function isCleanupRunning(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.cleanupStatus === 'running' || runtime.status === 'cleanup_pending'
}

export function hasCleanupStopped(runtime: EphemeralVmRuntimeRecord): boolean {
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
export function getExtendedEphemeralVmLeaseDeadline(
  runtime: EphemeralVmRuntimeRecord
): number | null {
  return resolveEphemeralVmRuntimeLease(runtime, Date.now())?.lifetime?.releaseAtMs ?? null
}

export function getEphemeralVmRuntimeStatusLabel(
  runtime: EphemeralVmRuntimeRecord,
  t: Translate = translate
): string {
  if (hasCleanupStopped(runtime)) {
    return t(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupStopped',
      'Cleanup stopped'
    )
  }
  if (hasCleanupFailed(runtime)) {
    return t('auto.components.settings.EphemeralVmRuntimesSection.cleanupFailed', 'Cleanup failed')
  }
  if (isCleanupRunning(runtime)) {
    return t(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupRunning',
      'Cleanup running'
    )
  }
  if (runtime.status === 'provisioning') {
    return t('auto.components.settings.EphemeralVmRuntimesSection.provisioning', 'Provisioning')
  }
  if (runtime.cleanupStatus === 'disabled') {
    return t(
      'auto.components.settings.EphemeralVmRuntimesSection.cleanupDisabled',
      'Cleanup disabled'
    )
  }
  if (runtime.status === 'running') {
    return t('auto.components.settings.EphemeralVmRuntimesSection.running', 'Running')
  }
  if (runtime.status === 'failed') {
    return t('auto.components.settings.EphemeralVmRuntimesSection.failed', 'Failed')
  }
  return runtime.status
}
