import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations/automation-definition'
import {
  AUTOMATION_STEPS_STAND_DOWN_PROMPT,
  getAutomationAgentPrompt
} from '../../../shared/automations/steps/automation-steps'
import { applyAutomationStepsWrite, withoutScriptStepApprovals } from './automation-steps-write'

const script = {
  kind: 'script',
  id: 'triage',
  script: 'scripts/triage.sh',
  timeoutSeconds: 30,
  onFailure: 'stop'
} as const
const agent = { kind: 'agent', id: 'agent' } as const

type StepsRecord = Pick<Automation, 'steps' | 'prompt' | 'surface'> & { bot?: unknown }

function record(fields: Partial<StepsRecord> = {}): StepsRecord {
  return { prompt: 'Summarize', ...fields }
}

/** A stored record as this host would hold it after a user approved its script. */
function approved(): StepsRecord {
  return {
    prompt: AUTOMATION_STEPS_STAND_DOWN_PROMPT,
    steps: [
      { ...script, approvedPin: 'pin' },
      { ...agent, prompt: 'Summarize' }
    ]
  }
}

describe('applyAutomationStepsWrite', () => {
  it('keeps a legacy record without steps, so older hosts read it unchanged', () => {
    const automation = record()
    const rename: { name: string; steps?: unknown } = { name: 'renamed' }
    applyAutomationStepsWrite(automation, rename, record())
    expect(automation).toEqual({ prompt: 'Summarize' })
  })

  it('gives an older host, which reads only `prompt`, the stand-down text for any record with steps', () => {
    const automation = record()
    applyAutomationStepsWrite(automation, { steps: [script, agent], prompt: 'Summarize' })
    expect(automation.prompt).toBe(AUTOMATION_STEPS_STAND_DOWN_PROMPT)
    expect(getAutomationAgentPrompt(automation)).toBe('Summarize')

    const cleared = record({ prompt: AUTOMATION_STEPS_STAND_DOWN_PROMPT })
    applyAutomationStepsWrite(cleared, { steps: null }, automation)
    expect(cleared).toEqual({ prompt: 'Summarize' })
  })

  it('stores a client-sent pin unapproved', () => {
    const automation = record()
    applyAutomationStepsWrite(automation, { steps: [{ ...script, approvedPin: 'forged' }, agent] })
    expect(automation.steps?.[0]).not.toHaveProperty('approvedPin')

    const update = record()
    applyAutomationStepsWrite(update, { steps: [{ ...script, approvedPin: 'forged' }] }, record())
    expect(update.steps?.[0]).not.toHaveProperty('approvedPin')
  })

  it('keeps a pin only while the step’s path and arguments are unchanged', () => {
    const kept = record()
    applyAutomationStepsWrite(kept, { steps: [script, agent] }, approved())
    expect(kept.steps?.[0]).toHaveProperty('approvedPin', 'pin')
    expect(getAutomationAgentPrompt(kept)).toBe('Summarize')

    for (const changed of [{ args: ['--all'] }, { script: 'scripts/other.sh' }]) {
      const automation = record()
      applyAutomationStepsWrite(
        automation,
        { steps: [{ ...script, ...changed }, agent] },
        approved()
      )
      expect(automation.steps?.[0]).not.toHaveProperty('approvedPin')
    }
  })

  it('keeps the agent prompt when a record is copied to another host, minus its approvals', () => {
    const copy = { ...withoutScriptStepApprovals(approved()) }
    const created = record({ prompt: copy.prompt })
    applyAutomationStepsWrite(created, { steps: copy.steps, prompt: copy.prompt })
    expect(getAutomationAgentPrompt(created)).toBe('Summarize')
    expect(created.steps?.[0]).not.toHaveProperty('approvedPin')
  })

  it('refuses steps on a bot, an agent step that is not last, and a chat agent', () => {
    expect(() =>
      applyAutomationStepsWrite(record({ bot: { botId: 'b' } }), { steps: [script] })
    ).toThrow('A bot automation cannot have script steps.')
    expect(() => applyAutomationStepsWrite(record(), { steps: [agent, script] })).toThrow(
      'The agent step must be the last step.'
    )
    expect(() =>
      applyAutomationStepsWrite(record({ surface: 'chat' }), { steps: [script, agent] })
    ).toThrow(/terminal agent/)
    const scriptOnly = record({ surface: 'chat' })
    applyAutomationStepsWrite(scriptOnly, { steps: [script] })
    expect(scriptOnly.steps).toEqual([script])
  })
})
