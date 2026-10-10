import { HOST_SETTINGS_API_KEY_PORTS } from './host-settings-api-key-ports'
import {
  createHostSettingsCredentialRegistry,
  type HostSettingsCredentialPort
} from './host-settings-credential-port'
import { createHostSettingsJiraPort } from './host-settings-jira-port'
import { createHostSettingsJenkinsPort } from './host-settings-jenkins-port'

/**
 * Every credential family this build can both send and receive.
 *
 * Why one list rather than a per-direction registry: a host that replicates to another only makes
 * sense when both ends agree, and a payload the sender can build but the receiver cannot apply is a
 * `refusedUnknownKind` the user has to read. Registering both halves in one place keeps that visible.
 *
 * Still missing, and each its own adapter rather than a row here: Bitbucket (a metadata file beside
 * its secret), Linear (a workspace list beside its token), and the structured provider payloads
 * (Fireworks, Copilot) that store a key and a second field in one envelope.
 */
export const HOST_SETTINGS_CREDENTIAL_PORTS: HostSettingsCredentialPort[] = [
  ...HOST_SETTINGS_API_KEY_PORTS,
  createHostSettingsJiraPort(),
  createHostSettingsJenkinsPort()
]

export const HOST_SETTINGS_CREDENTIAL_REGISTRY = createHostSettingsCredentialRegistry(
  HOST_SETTINGS_CREDENTIAL_PORTS
)
