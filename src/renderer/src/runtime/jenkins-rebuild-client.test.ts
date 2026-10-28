// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { hasJenkinsApi, rebuildJenkinsCheck } from './jenkins-rebuild-client'

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
      'https://github.com/stablyai/orca/actions/runs/123/job/456',
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
    rebuild.mockResolvedValue({
      ok: true,
      mode: 'parameters',
      buildNumber: 12,
      sentParameters: 2,
      omittedParameters: 0
    })

    const outcome = await rebuildJenkinsCheck(check())

    expect(rebuild).toHaveBeenCalledWith({ url: JENKINS_URL })
    expect(outcome).toEqual({
      ok: true,
      mode: 'parameters',
      message: expect.stringMatching(/this build’s parameters/)
    })
  })

  it('says how many parameters were left at the job default', async () => {
    rebuild.mockResolvedValue({
      ok: true,
      mode: 'parameters',
      buildNumber: 12,
      sentParameters: 1,
      omittedParameters: 2
    })

    const outcome = await rebuildJenkinsCheck(check())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.message).toMatch(/2 parameter\(s\) left at the job’s default/)
    // Why not also "with this build's parameters": some of them were not sent at all.
    expect(outcome.message).not.toMatch(/with this build’s parameters/)
  })

  it('does not claim a build was started when Jenkins only redirected', async () => {
    rebuild.mockResolvedValue({
      ok: false,
      reason: 'unconfirmed',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    const outcome = await rebuildJenkinsCheck(check())

    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/did not confirm the new build/)
    })
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

  it('refuses a second rerun of the same build while the first is in flight', async () => {
    let settle: (value: unknown) => void = () => undefined
    rebuild.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = rebuildJenkinsCheck(check())
    // Why: the toolbar's menu and the per-check button are separate affordances over one build.
    await expect(rebuildJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/already starting/)
    })

    settle({ ok: true, mode: 'build', buildNumber: 12, sentParameters: 0, omittedParameters: 0 })
    await expect(first).resolves.toEqual({
      ok: true,
      mode: 'build',
      message: 'Jenkins started a new build'
    })
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('refuses a second rerun of the same build reached through a different link', async () => {
    let settle: (value: unknown) => void = () => undefined
    rebuild.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = rebuildJenkinsCheck(check())
    // Why: a legacy status links `…/12/display/redirect` while a Checks-plugin run links `…/12/`,
    // and both name one build.
    await expect(
      rebuildJenkinsCheck(check({ url: 'https://ci.example.com/job/team/job/repo/12/' }))
    ).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/already starting/)
    })

    settle({ ok: true, mode: 'build', buildNumber: 12, sentParameters: 0, omittedParameters: 0 })
    await first
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('reports a client without Jenkins support instead of throwing', async () => {
    // The web client's fallback proxy resolves every call to undefined rather than throwing.
    rebuild.mockResolvedValue(undefined)

    await expect(rebuildJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.any(String)
    })
  })

  it('tells callers whether this client has a Jenkins surface at all', () => {
    expect(hasJenkinsApi()).toBe(true)
  })
})
