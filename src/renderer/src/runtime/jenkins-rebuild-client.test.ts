// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { hasJenkinsApi, rerunJenkinsCheck } from './jenkins-rebuild-client'

const rerunBuild = vi.fn()

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
  rerunBuild.mockReset()
  vi.stubGlobal('api', { jenkins: { rerunBuild } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rerunJenkinsCheck', () => {
  it('does not call Jenkins for a link that is not a Jenkins build', async () => {
    await expect(rerunJenkinsCheck(check({ url: null }))).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('does not link to a Jenkins build')
    })
    expect(rerunBuild).not.toHaveBeenCalled()
  })

  it('refuses a link that names no numbered build', async () => {
    for (const url of [
      // A GitHub Actions link parses as a job called `456` with no build of its own.
      'https://github.com/stablyai/orca/actions/runs/123/job/456',
      'https://gitlab.com/group/project/-/jobs/99',
      // A permalink names whatever build is newest when it is read, which may be another PR's.
      'https://ci.example.com/job/team/job/repo/lastBuild/'
    ]) {
      await expect(rerunJenkinsCheck(check({ url }))).resolves.toEqual({
        ok: false,
        error: expect.stringMatching(/does not link to (a|a numbered) Jenkins build/)
      })
    }
    expect(rerunBuild).not.toHaveBeenCalled()
  })

  it('sends only the link, so no parameter value can travel at all', async () => {
    rerunBuild.mockResolvedValue({ ok: true, buildNumber: 12 })

    const outcome = await rerunJenkinsCheck(check())

    expect(rerunBuild).toHaveBeenCalledWith({ url: JENKINS_URL })
    expect(outcome).toEqual({ ok: true, message: 'Jenkins is rerunning build #12' })
  })

  it('copes with a link that named a permalink rather than a number', async () => {
    rerunBuild.mockResolvedValue({ ok: true, buildNumber: null })

    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: true,
      message: 'Jenkins is rerunning this build'
    })
  })

  it('explains a freestyle job instead of claiming the build is gone', async () => {
    rerunBuild.mockResolvedValue({
      ok: false,
      reason: 'not-replayable',
      serverUrl: 'https://ci.example.com',
      message: 'Jenkins responded 404'
    })

    const outcome = await rerunJenkinsCheck(check())

    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/freestyle job rather than a pipeline/)
    })
  })

  it('says which permission the account is missing', async () => {
    rerunBuild.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/needs the Build permission/)
    })
  })

  it('does not claim a rerun happened when Jenkins only redirected', async () => {
    rerunBuild.mockResolvedValue({
      ok: false,
      reason: 'unconfirmed',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/did not confirm the rerun/)
    })
  })

  it('names the server to configure when there is none', async () => {
    rerunBuild.mockResolvedValue({
      ok: false,
      reason: 'not-configured',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/no Jenkins server configured for https:\/\/ci\.example\.com/)
    })
  })

  it('refuses a second rerun of the same build while the first is in flight', async () => {
    let settle: (value: unknown) => void = () => undefined
    rerunBuild.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = rerunJenkinsCheck(check())
    // Why: the toolbar's menu and the per-check button are separate affordances over one build.
    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/already starting/)
    })

    settle({ ok: true, buildNumber: 12 })
    await expect(first).resolves.toEqual({ ok: true, message: 'Jenkins is rerunning build #12' })
    expect(rerunBuild).toHaveBeenCalledTimes(1)
  })

  it('refuses a second rerun of the same build reached through a different link', async () => {
    let settle: (value: unknown) => void = () => undefined
    rerunBuild.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = rerunJenkinsCheck(check())
    // Why: a legacy status links `…/12/display/redirect` while a Checks-plugin run links `…/12/`,
    // and both name one build.
    await expect(
      rerunJenkinsCheck(check({ url: 'https://ci.example.com/job/team/job/repo/12/' }))
    ).resolves.toEqual({ ok: false, error: expect.stringMatching(/already starting/) })

    settle({ ok: true, buildNumber: 12 })
    await first
    expect(rerunBuild).toHaveBeenCalledTimes(1)
  })

  it('reports a client without Jenkins support instead of throwing', async () => {
    // The web client's fallback proxy resolves every call to undefined rather than throwing.
    rerunBuild.mockResolvedValue(undefined)

    await expect(rerunJenkinsCheck(check())).resolves.toEqual({
      ok: false,
      error: expect.any(String)
    })
  })

  it('tells callers whether this client has a Jenkins surface at all', () => {
    expect(hasJenkinsApi()).toBe(true)
  })
})
