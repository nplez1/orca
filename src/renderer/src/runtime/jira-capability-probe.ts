import type { JiraIssueUpdate } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY,
  JIRA_TRANSITION_FIELDS_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/jira/jira-detail-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/** Answers one host's capability question. Web fills it from the paired server's
 *  status, so the same refusals hold whichever client is asking. */
export type JiraCapabilityProbe = (capability: RuntimeCapability) => Promise<boolean>

/** The probe for a captured target: the local (or web) host runs this build, so a
 *  capability question only has an answer worth asking about a remote environment. */
export function jiraCapabilityProbeForTarget(target: RuntimeClientTarget): JiraCapabilityProbe {
  if (target.kind !== 'environment') {
    return async () => true
  }
  return (capability) =>
    runtimeEnvironmentSupportsCapability(target.environmentId, capability, 30_000).catch(
      () => false
    )
}

/** Refuses a transition-fields write on a host that would drop the fields, instead of
 *  letting it complete the transition without them. */
export async function assertJiraTransitionFieldsSupported(
  supports: JiraCapabilityProbe,
  updates: JiraIssueUpdate
): Promise<void> {
  if (!updates.transitionFields && updates.transitionComment === undefined) {
    return
  }
  if (!(await supports(JIRA_TRANSITION_FIELDS_RUNTIME_CAPABILITY))) {
    throw new Error(JIRA_TRANSITION_FIELDS_UPDATE_REQUIRED_MESSAGE)
  }
}
