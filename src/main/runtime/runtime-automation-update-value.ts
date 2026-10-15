import type { AutomationUpdateInput } from '../../shared/automations-types'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-controller'

/**
 * Copies the fields a runtime update forwards to the store.
 *
 * An allowlist rather than a spread: `repo`, `workspace` and `destination` address
 * the runtime, not the record, and must not reach the stored row.
 */
export function copyAutomationPatchValues(
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): void {
  const keys = [
    'name',
    'steps',
    'prompt',
    'precheck',
    'agentId',
    'extraAgentArgs',
    'runContext',
    'sourceContext',
    'baseBranch',
    'setupDecision',
    'reuseSession',
    'timezone',
    'rrule',
    'dtstart',
    'enabled',
    'missedRunGraceMinutes'
  ] as const
  for (const key of keys) {
    if (hasRuntimeAutomationUpdateValue(updates, key)) {
      Object.assign(patch, { [key]: updates[key] })
    }
  }
}

export function hasRuntimeAutomationUpdateValue<K extends keyof RuntimeAutomationUpdateInput>(
  updates: RuntimeAutomationUpdateInput,
  key: K
): boolean {
  return Object.hasOwn(updates, key) && updates[key] !== undefined
}
