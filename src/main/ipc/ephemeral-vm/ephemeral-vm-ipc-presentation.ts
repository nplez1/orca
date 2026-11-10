import type { EphemeralVmRecipeResultWarning } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmProvisionedRuntimeRecord } from '../../../shared/ephemeral-vm-runtimes'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { EphemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'

export type EphemeralVmProvisionIpcResult =
  | {
      ok: true
      connectionType: 'orca-server'
      runtime: EphemeralVmProvisionedRuntimeRecord
      environment: PublicKnownRuntimeEnvironment
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | {
      ok: true
      connectionType: 'ssh'
      runtime: EphemeralVmProvisionedRuntimeRecord
      sshTargetId: string
      /** The managed Orca server the host runs; its workspace lives there. */
      environmentId?: string
      expectedRefHead?: string
      stderr: string
      warnings: EphemeralVmRecipeResultWarning[]
    }
  | ({
      ok: false
      stderr: string
      stdout: string
    } & EphemeralVmFailure)

export function buildEphemeralEnvironmentName(repoName: string, runtimeId: string): string {
  return `${repoName} VM ${runtimeId.slice(-8)}`
}

export function provisionFailure(failure: EphemeralVmFailure): EphemeralVmProvisionIpcResult {
  return { ok: false, ...failure, stdout: '', stderr: '' }
}
