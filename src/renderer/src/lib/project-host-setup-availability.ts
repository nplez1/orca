import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host/execution-host-registry-entry'
import { isHostLocalProjectId } from '../../../shared/project-host-setup-projection'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { ProjectHostSetup } from '../../../shared/project-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

/** Why a host cannot take this project at all, from the host's own state. */
export function getHostSetupUnavailableDetail(
  host: ExecutionHostRegistryEntry,
  t: Translate = translate
): string | null {
  if (host.health === 'blocked') {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupBlockedVersion',
      'Orca server version is incompatible'
    )
  }
  if (host.kind !== 'runtime') {
    return null
  }
  if (!host.capabilities) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupCheckingCapability',
      'Checking host capabilities'
    )
  }
  if (
    !host.capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
    !host.capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
  ) {
    return t(
      'auto.components.settings.RepositoryPane.hostSetupMissingCapability',
      'Update Orca on this host to set up projects'
    )
  }
  return null
}

export function getHostHealthUnavailableDetail(
  health: ExecutionHostRegistryEntry['health']
): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}

/**
 * Why this project cannot be given a location on this host, stated where the user would otherwise
 * click a dead row. Distinct from the host's own health: this pair holds however healthy it is.
 */
export function getProjectLocationUnavailableDetail(
  projectId: string,
  hostId: ExecutionHostId
): string | null {
  // Why: repo:<id> is a host-local key, so no other host can match the project it names.
  if (isHostLocalProjectId(projectId)) {
    return translate(
      'auto.components.settings.RepositoryPane.projectNeedsRemote',
      'Add a remote to this project first'
    )
  }
  // Why: project setup on an ssh target is refused by the store; the project lives on a Remote Orca Server there.
  if (parseExecutionHostId(hostId)?.kind === 'ssh') {
    return translate(
      'auto.components.settings.RepositoryPane.projectSetupNeedsServer',
      'Set this project up from a Remote Orca Server on that host'
    )
  }
  return null
}

export function canSetProjectLocation(
  projectId: string,
  isAvailable: boolean,
  pendingSetup: ProjectHostSetup | undefined,
  hostId: ExecutionHostId
): boolean {
  // Cross-host setup links project identity; host-local repo:<id> has no match, so show status instead of a guaranteed error button.
  if (!isAvailable || getProjectLocationUnavailableDetail(projectId, hostId) !== null) {
    return false
  }
  if (!pendingSetup) {
    return true
  }
  return pendingSetup.setupState === 'not-set-up' || pendingSetup.setupState === 'error'
}

export function getPendingSetupDetail(setup: ProjectHostSetup): string {
  switch (setup.setupState) {
    case 'not-set-up':
      return 'Project tracked on this host but not set up'
    case 'setting-up':
      return 'Project setup is in progress'
    case 'error':
      return 'Project setup needs attention'
    case 'unsupported':
      return 'Project is unsupported on this host'
    case 'ready':
      return setup.path
  }
}
