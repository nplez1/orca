// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { rerunChecksAcrossProviders } from './pr-checks-rerun'

const rebuildJenkinsCheck = vi.fn()

vi.mock('@/runtime/jenkins-rebuild-client', () => ({
  rebuildJenkinsCheck: (...args: unknown[]) => rebuildJenkinsCheck(...args)
}))

function check(overrides: Partial<PRCheckDetail>): PRCheckDetail {
  return {
    name: 'check',
    status: 'completed',
    conclusion: 'failure',
    url: null,
    ...overrides
  }
}

const jenkinsCheck = (overrides: Partial<PRCheckDetail> = {}): PRCheckDetail =>
  check({
    name: 'continuous-integration/jenkins/pr-merge',
    url: 'https://ci.example.com/job/team/job/repo/12/display/redirect',
    ...overrides
  })

const actionsCheck = (overrides: Partial<PRCheckDetail> = {}): PRCheckDetail =>
  check({
    name: 'build',
    url: 'https://github.com/stablyai/orca/actions/runs/123/job/456',
    ...overrides
  })

beforeEach(() => {
  rebuildJenkinsCheck.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rerunChecksAcrossProviders', () => {
  it('reruns both providers for a mixed failure list', async () => {
    const rerunGitHub = vi.fn().mockResolvedValue({ ok: true, count: 1 })
    rebuildJenkinsCheck.mockResolvedValue({
      ok: true,
      mode: 'parameters',
      message: 'Jenkins started a new build'
    })

    const outcome = await rerunChecksAcrossProviders({
      checks: [actionsCheck(), jenkinsCheck()],
      failedOnly: true,
      rerunGitHub
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.started).toBe(2)
    expect(outcome.message).toMatch(/1 GitHub check/)
    expect(outcome.message).toMatch(/1 Jenkins build/)
  })

  it('never asks GitHub about a list whose only failure is a Jenkins build', async () => {
    const rerunGitHub = vi.fn()
    rebuildJenkinsCheck.mockResolvedValue({
      ok: true,
      mode: 'build',
      message: 'Jenkins started a new build'
    })

    const outcome = await rerunChecksAcrossProviders({
      checks: [jenkinsCheck()],
      failedOnly: true,
      rerunGitHub
    })

    // Why: asking GitHub here is what produced "No failed GitHub Actions checks to rerun."
    expect(rerunGitHub).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: true, started: 1, message: 'Jenkins started a new build' })
  })

  it('reports what started when one leg fails', async () => {
    const rerunGitHub = vi.fn().mockResolvedValue({ ok: false, error: 'gh exploded' })
    rebuildJenkinsCheck.mockResolvedValue({
      ok: true,
      mode: 'build',
      message: 'Jenkins started a new build'
    })

    const outcome = await rerunChecksAcrossProviders({
      checks: [actionsCheck(), jenkinsCheck()],
      failedOnly: true,
      rerunGitHub
    })

    // Why the count: a rerun POST is not idempotent, so the user has to know a build did start
    // before they retry and start it twice.
    expect(outcome.ok).toBe(false)
    expect(outcome.started).toBe(1)
    expect(outcome.message).toMatch(/1 rerun\(s\) already started/)
    expect(outcome.message).toMatch(/gh exploded/)
  })

  it('keeps going when one leg throws', async () => {
    const rerunGitHub = vi.fn().mockRejectedValue(new Error('rpc timed out'))
    rebuildJenkinsCheck.mockResolvedValue({
      ok: true,
      mode: 'build',
      message: 'Jenkins started a new build'
    })

    const outcome = await rerunChecksAcrossProviders({
      checks: [actionsCheck(), jenkinsCheck()],
      failedOnly: true,
      rerunGitHub
    })

    // The throw used to abort the loop and discard the count of what had started.
    expect(rebuildJenkinsCheck).toHaveBeenCalledTimes(1)
    expect(outcome.started).toBe(1)
    expect(outcome.message).toMatch(/rpc timed out/)
  })

  it('says there is nothing to rerun without calling either provider', async () => {
    const rerunGitHub = vi.fn()

    const outcome = await rerunChecksAcrossProviders({
      checks: [check({ conclusion: 'success', workflowRunId: 1 })],
      failedOnly: true,
      rerunGitHub
    })

    expect(outcome).toEqual({
      ok: false,
      started: 0,
      message: 'No failed checks to rerun.'
    })
    expect(rerunGitHub).not.toHaveBeenCalled()
    expect(rebuildJenkinsCheck).not.toHaveBeenCalled()
  })
})
