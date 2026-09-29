import { describe, expect, it } from 'vitest'
import type { PRCheckJob, PRCheckStep } from './github/check-types'
import {
  isFailedStepState,
  isRunningStepState,
  paneCheckSteps,
  rendersEveryStep,
  visibleCheckSteps
} from './check-step-visibility'

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

describe('isRunningStepState', () => {
  it('counts every unsettled state and nothing else', () => {
    for (const state of [
      'pending',
      'action_required',
      'queued',
      'in_progress',
      'requested',
      'waiting',
      null
    ]) {
      expect(isRunningStepState({ status: state, conclusion: null })).toBe(true)
    }
    for (const state of ['success', 'failure', 'skipped', 'neutral']) {
      expect(isRunningStepState({ status: 'completed', conclusion: state })).toBe(false)
    }
  })
})

describe('paneCheckSteps', () => {
  it('keeps a stage list to what is running or failed', () => {
    const steps = [
      step('Checkout', 'success'),
      step('Test', 'failure'),
      step('Deploy', 'pending'),
      step('Smoke', 'success'),
      step('Lint', 'skipped')
    ]
    // Running first, so "where is it now" leads over "what already broke".
    expect(paneCheckSteps(job(steps, 'all')).steps.map((entry) => entry.name)).toEqual([
      'Deploy',
      'Test'
    ])
  })

  it('caps the list and reports how many were held back', () => {
    const steps = Array.from({ length: 10 }, (_, index) => step(`S${index}`, 'failure'))
    const result = paneCheckSteps(job(steps, 'all'), 4)
    expect(result.steps.map((entry) => entry.name)).toEqual(['S0', 'S1', 'S2', 'S3'])
    expect(result.hiddenCount).toBe(6)
  })

  it('keeps the running stage even when earlier failures fill the cap', () => {
    const steps = [
      ...Array.from({ length: 10 }, (_, index) => step(`F${index}`, 'failure')),
      step('Running', 'in_progress')
    ]
    const result = paneCheckSteps(job(steps, 'all'), 2)
    expect(result.steps.map((entry) => entry.name)).toEqual(['Running', 'F0'])
    expect(result.hiddenCount).toBe(9)
  })

  it('does not recurse into a stage’s steps', () => {
    const steps: PRCheckStep[] = [
      {
        name: 'Test',
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
        children: [
          {
            name: 'Shell Script',
            status: 'completed',
            conclusion: 'failure',
            startedAt: null,
            completedAt: null
          }
        ]
      }
    ]
    expect(paneCheckSteps(job(steps, 'all')).steps).toEqual([])
  })

  it('keeps the GitHub failures-only list untouched', () => {
    const steps = [step('Checkout', 'success'), step('Test', 'failure')]
    expect(paneCheckSteps(job(steps)).steps.map((entry) => entry.name)).toEqual(['Test'])
    expect(paneCheckSteps(job(steps)).hiddenCount).toBe(0)
  })
})
