import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import { AUTOMATION_SCRIPT_ONLY_FALLBACK_PROMPT } from '../../../shared/automations/steps/automation-steps'
import { applyAutomationStepsWrite } from './automation-steps-write'

const script = {
  kind: 'script',
  id: 'triage',
  script: 'scripts/triage.sh',
  timeoutSeconds: 30,
  onFailure: 'stop',
  approvedContentHash: 'abc'
} as const

type StepsRecord = Pick<Automation, 'steps' | 'prompt'> & { bot?: unknown }

function record(fields: Partial<StepsRecord> = {}): StepsRecord {
  return { prompt: 'Summarize', ...fields }
}

describe('applyAutomationStepsWrite', () => {
  it('keeps a legacy record without steps, so older hosts read it unchanged', () => {
    const automation = record()
    const rename: { name: string; steps?: unknown } = { name: 'renamed' }
    applyAutomationStepsWrite(automation, rename)
    expect(automation).not.toHaveProperty('steps')
    expect(automation.prompt).toBe('Summarize')
  })

  it('stores script-then-agent steps and keeps them across unrelated writes', () => {
    const steps = [script, { kind: 'agent', id: 'agent' }]
    const created = record()
    applyAutomationStepsWrite(created, { steps })
    expect(created.steps).toEqual(steps)

    const updated = record()
    applyAutomationStepsWrite(updated, {}, created)
    expect(updated.steps).toEqual(steps)
    expect(updated.prompt).toBe('Summarize')
  })

  it('stores a stand-down prompt for a script-only record, and null returns to agent-only', () => {
    const scriptOnly = record()
    applyAutomationStepsWrite(scriptOnly, { steps: [script] })
    expect(scriptOnly.prompt).toBe(AUTOMATION_SCRIPT_ONLY_FALLBACK_PROMPT)

    const cleared = record()
    applyAutomationStepsWrite(cleared, { steps: null }, scriptOnly)
    expect(cleared).not.toHaveProperty('steps')
  })

  it('refuses steps on a bot automation and an agent step that is not last', () => {
    expect(() =>
      applyAutomationStepsWrite(record({ bot: { botId: 'b' } }), { steps: [script] })
    ).toThrow('A bot automation cannot have script steps.')
    expect(() =>
      applyAutomationStepsWrite(record(), { steps: [{ kind: 'agent', id: 'agent' }, script] })
    ).toThrow('The agent step must be the last step.')
  })
})
