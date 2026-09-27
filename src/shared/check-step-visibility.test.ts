import { describe, expect, it } from 'vitest'
import type { PRCheckJob, PRCheckStep } from './github/check-types'
import { isFailedStepState, rendersEveryStep, visibleCheckSteps } from './check-step-visibility'

const step = (name: string, state: string): PRCheckStep => ({
  name,
  status: state,
  conclusion: null,
  startedAt: null,
  completedAt: null
})

const job = (steps: PRCheckStep[], stepRendering?: PRCheckJob['stepRendering']): PRCheckJob => ({
  id: null,
  name: 'job',
  status: null,
  conclusion: null,
  startedAt: null,
  completedAt: null,
  url: null,
  logTail: null,
  steps,
  ...(stepRendering ? { stepRendering } : {})
})

describe('visibleCheckSteps', () => {
  it('keeps a GitHub Actions job to its failures', () => {
    const steps = [
      step('Checkout', 'success'),
      step('Test', 'failure'),
      step('Deploy', 'skipped'),
      step('Smoke', 'in_progress')
    ]
    expect(visibleCheckSteps(job(steps)).map((entry) => entry.name)).toEqual(['Test'])
  })

  it('lists every stage of a stage list, including the one still running', () => {
    const steps = [
      step('Checkout', 'success'),
      step('Test', 'failure'),
      step('Deploy', 'pending'),
      step('Smoke', 'success')
    ]
    expect(visibleCheckSteps(job(steps, 'all')).map((entry) => entry.name)).toEqual([
      'Checkout',
      'Test',
      'Deploy',
      'Smoke'
    ])
  })

  it('treats an explicit failures-only marker like the default', () => {
    const steps = [step('Test', 'success'), step('Lint', 'failure')]
    expect(visibleCheckSteps(job(steps, 'failures-only')).map((entry) => entry.name)).toEqual([
      'Lint'
    ])
  })

  it('reads the conclusion before the status', () => {
    const steps: PRCheckStep[] = [
      {
        name: 'Build',
        status: 'completed',
        conclusion: 'failure',
        startedAt: null,
        completedAt: null
      }
    ]
    expect(visibleCheckSteps(job(steps)).map((entry) => entry.name)).toEqual(['Build'])
  })
})

describe('rendersEveryStep', () => {
  it('only widens for an explicit stage list', () => {
    expect(rendersEveryStep({ stepRendering: 'all' })).toBe(true)
    expect(rendersEveryStep({ stepRendering: 'failures-only' })).toBe(false)
    expect(rendersEveryStep({})).toBe(false)
  })
})

describe('isFailedStepState', () => {
  it('counts every not-passing state and nothing else', () => {
    for (const state of ['failure', 'failed', 'cancelled', 'timed_out']) {
      expect(isFailedStepState(state)).toBe(true)
    }
    for (const state of ['success', 'skipped', 'neutral', 'pending', 'in_progress', '', null]) {
      expect(isFailedStepState(state)).toBe(false)
    }
  })
})
