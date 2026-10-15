import { describe, expect, it } from 'vitest'
import {
  applyAutomationStepPatch,
  automationLegacyAgentFields,
  formatAutomationStepsSummary,
  parseAutomationSteps,
  resolveAutomationAgentStep,
  resolveAutomationSteps,
  validateAutomationSteps,
  type AutomationScriptStep,
  type AutomationStep
} from './automation-steps'

const script = (
  command: string,
  overrides: Partial<Omit<AutomationScriptStep, 'kind' | 'command'>> = {}
): AutomationStep => ({
  kind: 'script',
  command,
  timeoutSeconds: 900,
  onFailure: 'stop',
  ...overrides
})

const agent = (
  prompt = 'Summarise what changed.',
  agentId = 'claude' as const
): AutomationStep => ({
  kind: 'agent',
  prompt,
  agentId
})

describe('validateAutomationSteps', () => {
  it('refuses an empty plan rather than storing an automation with nothing to do', () => {
    expect(validateAutomationSteps([])).toEqual({
      ok: false,
      error: 'An automation needs at least one step.'
    })
    expect(validateAutomationSteps(null)).toMatchObject({ ok: false })
  })

  it('accepts script steps alone, which is the whole point', () => {
    const result = validateAutomationSteps([script('pnpm build')])
    expect(result).toEqual({
      ok: true,
      steps: [{ kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }]
    })
  })

  it('refuses a script step after the agent step', () => {
    expect(validateAutomationSteps([agent(), script('pnpm build')])).toEqual({
      ok: false,
      error:
        'The agent step has to be the last step, because it ends the run by handing it to a terminal.'
    })
  })

  it('refuses more than one agent step', () => {
    expect(validateAutomationSteps([agent(), agent()])).toEqual({
      ok: false,
      error: 'An automation can have only one agent step.'
    })
  })

  it('refuses an empty command and an empty prompt', () => {
    expect(validateAutomationSteps([script('   ')])).toEqual({
      ok: false,
      error: 'Step 1 has no command.'
    })
    expect(validateAutomationSteps([agent('  ')])).toEqual({
      ok: false,
      error: 'The agent step has no prompt.'
    })
  })

  it('clamps a timeout into the range a run can survive', () => {
    const result = validateAutomationSteps([
      script('a', { timeoutSeconds: 1 }),
      script('b', { timeoutSeconds: 999_999 })
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.steps[0]).toMatchObject({ timeoutSeconds: 5 })
      expect(result.steps[1]).toMatchObject({ timeoutSeconds: 3600 })
    }
  })
})

describe('parseAutomationSteps', () => {
  it('reads the JSON the CLI takes, defaulting timeout and onFailure', () => {
    const result = parseAutomationSteps([
      { kind: 'script', command: ' pnpm build ' },
      { kind: 'agent', prompt: 'Report.', agentId: 'codex' }
    ])
    expect(result).toEqual({
      ok: true,
      steps: [
        { kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' },
        { kind: 'agent', prompt: 'Report.', agentId: 'codex' }
      ]
    })
  })

  it('rejects a non-array, an unknown kind, and an agent step with no agent', () => {
    expect(parseAutomationSteps({ kind: 'script' })).toMatchObject({ ok: false })
    expect(parseAutomationSteps([{ kind: 'shell', command: 'ls' }])).toEqual({
      ok: false,
      error: 'Step 1 must have kind "script" or "agent".'
    })
    expect(parseAutomationSteps([{ kind: 'agent', prompt: 'Report.' }])).toEqual({
      ok: false,
      error: 'Step 1 is an agent step with no agentId.'
    })
  })
})

describe('resolveAutomationSteps', () => {
  it('reads a stored plan as it is', () => {
    expect(resolveAutomationSteps({ steps: [script('pnpm build')] })).toEqual([
      { kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }
    ])
  })

  it('reads a record written before steps existed as its one agent step', () => {
    expect(resolveAutomationSteps({ prompt: 'Triage issues.', agentId: 'claude' })).toEqual([
      { kind: 'agent', prompt: 'Triage issues.', agentId: 'claude' }
    ])
  })

  it('keeps a legacy record with a blank prompt as one bare agent step', () => {
    expect(resolveAutomationSteps({ prompt: '', agentId: 'codex' })).toEqual([
      { kind: 'agent', prompt: '', agentId: 'codex' }
    ])
  })

  it('reports nothing for a record with neither a plan nor an agent', () => {
    expect(resolveAutomationSteps({})).toEqual([])
    expect(resolveAutomationAgentStep({ steps: [script('pnpm build')] })).toBeNull()
  })

  it('reports an agent step that a reader can act on', () => {
    expect(resolveAutomationAgentStep({ steps: [script('pnpm build'), agent('Report.')] })).toEqual(
      { kind: 'agent', prompt: 'Report.', agentId: 'claude' }
    )
  })
})

describe('applyAutomationStepPatch', () => {
  it('leaves the plan alone for a patch that does not touch it', () => {
    expect(applyAutomationStepPatch({ current: { steps: [script('a')] }, patch: {} })).toEqual({
      ok: true,
      steps: null
    })
  })

  it('replaces the plan when the patch carries one', () => {
    const result = applyAutomationStepPatch({
      current: { steps: [script('a')] },
      patch: { steps: [script('b'), agent()] }
    })
    expect(result).toEqual({
      ok: true,
      steps: [
        { kind: 'script', command: 'b', timeoutSeconds: 900, onFailure: 'stop' },
        { kind: 'agent', prompt: 'Summarise what changed.', agentId: 'claude' }
      ]
    })
  })

  it('edits the agent step inside the plan when only the flat fields are patched', () => {
    const result = applyAutomationStepPatch({
      current: { steps: [script('pnpm build'), agent('Old.')] },
      patch: { prompt: 'New.', agentId: 'codex' }
    })
    expect(result).toEqual({
      ok: true,
      steps: [
        { kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' },
        { kind: 'agent', prompt: 'New.', agentId: 'codex' }
      ]
    })
  })

  it('adds an agent step last when a script-only plan is given one', () => {
    const result = applyAutomationStepPatch({
      current: { steps: [script('pnpm build')] },
      patch: { prompt: 'Report the build.', agentId: 'claude' }
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.steps?.map((step) => step.kind)).toEqual(['script', 'agent'])
    }
  })

  it('refuses an agent step with no prompt or no agent', () => {
    expect(
      applyAutomationStepPatch({ current: { steps: [script('a')] }, patch: { prompt: '  ' } })
    ).toEqual({ ok: false, error: 'An agent step needs both a prompt and an agent.' })
    expect(
      applyAutomationStepPatch({
        current: { steps: [script('a'), agent()] },
        patch: { prompt: '' }
      })
    ).toEqual({ ok: false, error: 'An agent step needs a prompt.' })
  })
})

describe('the record mirror older readers still see', () => {
  it('describes the agent step, and clears when the plan has none', () => {
    expect(
      automationLegacyAgentFields({ steps: [script('pnpm build'), agent('Report.')] })
    ).toEqual({ prompt: 'Report.', agentId: 'claude' })
    expect(automationLegacyAgentFields({ steps: [script('pnpm build')] })).toEqual({
      prompt: '',
      agentId: null
    })
  })
})

describe('formatAutomationStepsSummary', () => {
  it('names the split in one line', () => {
    expect(formatAutomationStepsSummary({ steps: [script('a')] })).toBe('1 script step')
    expect(formatAutomationStepsSummary({ steps: [agent()] })).toBe('1 agent step')
    expect(formatAutomationStepsSummary({ steps: [script('a'), agent()] })).toBe(
      '1 script step, then an agent'
    )
    expect(formatAutomationStepsSummary({ steps: [script('a'), script('b'), agent()] })).toBe(
      '2 script steps, then an agent'
    )
  })
})
