import type { Automation } from '../../shared/automations/automation-definition'
import type { CommandHandler } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { writeStdoutLine } from '../output/stdout-line'
import { formatAutomationEnabled, type AutomationShowPayload } from './automation-format'

// Read the authoritative owner for fencing; older hosts omit it and impose no precondition.
export async function resolveAutomationMutationState(
  client: Parameters<CommandHandler>[0]['client'],
  id: string
): Promise<AutomationShowPayload> {
  const result = await client.call<AutomationShowPayload>('automation.show', { id })
  return result.result
}

/** `enable` and `disable` are one write with the flag flipped; both fence the owner first. */
async function setAutomationEnabled(args: {
  client: Parameters<CommandHandler>[0]['client']
  flags: Parameters<CommandHandler>[0]['flags']
  json: boolean
  enabled: boolean
}): Promise<void> {
  const id = getRequiredStringFlag(args.flags, 'id')
  const { owner: expectedOwner, automation } = await resolveAutomationMutationState(args.client, id)
  if (automation.enabled === args.enabled) {
    writeStdoutLine(`${automation.name} is already ${args.enabled ? 'on' : 'off'}.`)
    return
  }
  const result = await args.client.call<{ automation: Automation }>('automation.update', {
    id,
    ...(expectedOwner ? { expectedOwner } : {}),
    updates: { enabled: args.enabled }
  })
  printResult(result, args.json, (value) => formatAutomationEnabled(value, args.enabled))
}

export const AUTOMATION_ENABLED_HANDLERS: Record<string, CommandHandler> = {
  'automations enable': async ({ flags, client, json }) => {
    await setAutomationEnabled({ client, flags, json, enabled: true })
  },
  'automations disable': async ({ flags, client, json }) => {
    await setAutomationEnabled({ client, flags, json, enabled: false })
  }
}
