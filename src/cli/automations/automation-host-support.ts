import {
  AUTOMATION_COMMAND_RUNTIME_CAPABILITY,
  AUTOMATION_COMMAND_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY
} from '../../shared/automations/automation-runtime-capabilities'
import type { AutomationAction } from '../../shared/automations/automation-definition'
import {
  EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED,
  hasExtraAgentArgs
} from '../../shared/agent-launch/startup/automation-extra-agent-args'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

const SETUP_CHOICE_HOST_UPDATE_REQUIRED =
  "This host's Orca is too old for --setup on automations. Update Orca on that host, or run the command without --setup."

// Older runtimes silently strip these fields and would run without the requested arguments or setup choice.
export async function assertAutomationFieldsSupported(
  client: RuntimeClient,
  fields: {
    extraAgentArgs?: string
    setupDecision?: 'run' | 'skip'
    action?: AutomationAction | null
  }
): Promise<void> {
  const needsExtraAgentArgs = hasExtraAgentArgs(fields.extraAgentArgs)
  const needsCommand = fields.action?.kind === 'command'
  if (!needsExtraAgentArgs && fields.setupDecision === undefined && !needsCommand) {
    return
  }
  const capabilities = (await client.call<RuntimeStatus>('status.get')).result.capabilities ?? []
  if (
    needsExtraAgentArgs &&
    !capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError('incompatible_runtime', EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED)
  }
  if (needsCommand && !capabilities.includes(AUTOMATION_COMMAND_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError('incompatible_runtime', AUTOMATION_COMMAND_UPDATE_REQUIRED_MESSAGE)
  }
  if (
    fields.setupDecision !== undefined &&
    !capabilities.includes(AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError('incompatible_runtime', SETUP_CHOICE_HOST_UPDATE_REQUIRED)
  }
}
