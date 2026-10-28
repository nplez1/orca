// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { rebuildJenkinsCheck } from './jenkins-rebuild-client'

const rebuild = vi.fn()

const JENKINS_URL = 'https://ci.example.com/job/team/job/repo/12/display/redirect'

function check(overrides: Partial<PRCheckDetail> = {}): PRCheckDetail {
  return {
    name: 'continuous-integration/jenkins/pr-merge',
    status: 'completed',
    conclusion: 'failure',
    url: JENKINS_URL,
    ...overrides
  }
}

beforeEach(() => {
  rebuild.mockReset()
  vi.stubGlobal('api', { jenkins: { rebuild } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rebuildJenkinsCheck', () => {
  it('does not call Jenkins for a check another provider owns', async () => {
    for (const url of [
      null,
      'https://github.com/stablyai/orca/actions/runs/123',
      'https://gitlab.com/group/project/-/jobs/99'
    ]) {
      await expect(rebuildJenkinsCheck(check({ url }))).resolves.toEqual({
        ok: false,
        error: expect.stringContaining('does not link to a Jenkins build')
      })
    }
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('sends only the link, so no masked parameter can travel back to Jenkins', async () => {
    rebuild.mockResolvedValue({ ok: true, mode: 'rebuild', buildNumber: 12 })

    const outcome = await rebuildJenkinsCheck(check())

    expect(rebuild).toHaveBeenCalledWith({ url: JENKINS_URL })
    expect(outcome).toEqual({
      ok: true,
      mode: 'rebuild',
      message: expect.stringContaining('#12')
    })
  })

  it('says a new build was started when the build could not be replayed', async () => {
    rebuild.mockResolvedValue({ ok: true, mode: 'parameters', buildNumber: 12 })

    const outcome = await rebuildJenkinsCheck(check())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.message).toMatch(/same parameters/)
  })

  it('names the server to configure when there is none', async () => {
    rebuild.mockResolvedValue({
      ok: false,
      reason: 'not-configured',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    const outcome = await rebuildJenkinsCheck(check())

    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/no Jenkins server configured for https:\/\/ci\.example\.com/)
    })
  })

  it('distinguishes a refused token from a build with no number', async () => {
    rebuild.mockResolvedValue({
      ok: false,
      reason: 'unauthorized',
      serverUrl: 'https://ci.example.com',
      message: null
    })
    await expect(rebuildJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/rejected the saved credentials/)
    })

    rebuild.mockResolvedValue({
      ok: false,
      reason: 'no-build',
      serverUrl: 'https://ci.example.com',
      message: null
    })
    await expect(rebuildJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/numbered Jenkins build/)
    })
  })

  it('reports a client without Jenkins support instead of throwing', async () => {
    // The web client's fallback proxy resolves every call to undefined rather than throwing.
    rebuild.mockResolvedValue(undefined)

    await expect(rebuildJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.any(String)
    })
  })
})
