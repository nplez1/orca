/** What to suggest when a server cannot be reached, chosen by the kind of host that owns it. */
import { isRemoteRuntimeUnreachableMessage } from '../../../shared/remote-runtime-client-error-classification'
import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import {
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'

const EPHEMERAL_VM_ENDPOINT_HINT =
  'Orca created this VM, so this is not a network setup problem: Settings → Ephemeral VMs shows its state and can release the machine.'

/**
 * Why not Tailscale: an ephemeral VM is a machine Orca allocated through the recipe's provider,
 * so the tailnet advice is about a topology the user never chose — and the remedy is on this
 * desktop, not on their network. Named before `classifyRuntimeEnvironmentHost` because a VM is
 * reached over the network (or an SSH tunnel) and would otherwise classify as one.
 */
function withEphemeralVmUnreachableHint(message: string): string {
  if (!isRemoteRuntimeUnreachableMessage(message)) {
    return message
  }
  // Why: same idempotence as the Tailscale hint — a re-wrapped error must not gain it twice.
  if (message.endsWith(EPHEMERAL_VM_ENDPOINT_HINT)) {
    return message
  }
  return `${message} ${EPHEMERAL_VM_ENDPOINT_HINT}`
}

export function withRuntimeUnreachableHint(
  environment: Pick<KnownRuntimeEnvironment, 'orcadDeployment' | 'source'>,
  message: string,
  endpoint: string | null | undefined
): string {
  if (isEphemeralVmRuntimeEnvironment(environment)) {
    return withEphemeralVmUnreachableHint(message)
  }
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'network':
      return withRemoteRuntimeTailscaleHint(message, endpoint)
    case 'wsl':
      // Why not Tailscale: a WSL host is a distro on this computer, reached over wsl.exe.
      return isRemoteRuntimeUnreachableMessage(message)
        ? `${message} The Orca server in the WSL distro ${host.deployment.distro} isn’t answering; connect it again in Settings → Remote Orca Servers → WSL hosts.`
        : message
  }
}
