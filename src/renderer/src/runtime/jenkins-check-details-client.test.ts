// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../shared/github/check-types'
import {
  loadCheckDetailsWithProviderFallback,
  loadJenkinsCheckDetails
} from './jenkins-check-details-client'
import { JenkinsCheckDetailsError, checkDetailsErrorAction } from '@/lib/check-details-error-action'

const buildDetails = vi.fn()

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

const details: PRCheckRunDetails = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/12/',
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: '#12',
  summary: null,
  text: null,
  annotations: [],
  jobs: []
}

beforeEach(() => {
  buildDetails.mockReset()
  vi.stubGlobal('api', { jenkins: { buildDetails } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadJenkinsCheckDetails', () => {
  it('does not call Jenkins for a check another provider owns', async () => {
    for (const url of [
      null,
      'https://github.com/stablyai/orca/actions/runs/123',
      'https://gitlab.com/group/project/-/jobs/99'
    ]) {
      await expect(loadJenkinsCheckDetails(check({ url }))).resolves.toBeNull()
    }
    expect(buildDetails).not.toHaveBeenCalled()
  })

  it('returns the details Jenkins reported', async () => {
    buildDetails.mockResolvedValue({ ok: true, details })

    await expect(loadJenkinsCheckDetails(check())).resolves.toBe(details)
    expect(buildDetails).toHaveBeenCalledWith({
      url: JENKINS_URL,
      checkName: 'continuous-integration/jenkins/pr-merge',
      status: 'completed',
      conclusion: 'failure'
    })
  })

  it('falls through when the host turns out not to be Jenkins', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'not-jenkins',
      serverUrl: null,
      message: null
    })

    await expect(loadJenkinsCheckDetails(check())).resolves.toBeNull()
  })

  it('explains which server to add when none is configured', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'not-configured',
      serverUrl: 'https://ci.example.com',
      message: 'Jenkins responded 401'
    })

    await expect(loadJenkinsCheckDetails(check())).rejects.toThrow(
      /no Jenkins server configured for https:\/\/ci\.example\.com/
    )
  })

  it('explains a rejected token and an unreachable host distinctly', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'unauthorized',
      serverUrl: 'https://ci.example.com',
      message: null
    })
    await expect(loadJenkinsCheckDetails(check())).rejects.toThrow(/rejected the saved credentials/)

    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'unreachable',
      serverUrl: 'https://ci.example.com',
      message: 'net::ERR_CERT_AUTHORITY_INVALID'
    })
    await expect(loadJenkinsCheckDetails(check())).rejects.toThrow(
      /Could not reach https:\/\/ci\.example\.com/
    )
  })

  it('treats a client without Jenkins support as not-Jenkins', async () => {
    // The web client's fallback proxy resolves every call to undefined rather than throwing.
    buildDetails.mockResolvedValue(undefined)

    await expect(loadJenkinsCheckDetails(check())).resolves.toBeNull()
  })

  it('carries the failure reason so a surface can offer settings', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    const thrown = await loadJenkinsCheckDetails(check()).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(JenkinsCheckDetailsError)
    expect(checkDetailsErrorAction(thrown)).toEqual({ kind: 'open-jenkins-settings' })
  })

  it('offers no settings link for a failure the user cannot fix there', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'timeout',
      serverUrl: 'https://ci.example.com',
      message: null
    })

    const thrown = await loadJenkinsCheckDetails(check()).catch((error: unknown) => error)
    expect(checkDetailsErrorAction(thrown)).toBeNull()
  })
})

describe('loadCheckDetailsWithProviderFallback', () => {
  it('leaves the caller’s provider path untouched for a check Jenkins does not own', async () => {
    const own = vi.fn(async () => details)

    await expect(loadCheckDetailsWithProviderFallback(check({ url: null }), own)).resolves.toBe(
      details
    )
    expect(own).toHaveBeenCalledTimes(1)
  })

  it('never asks the caller’s provider once Jenkins answers', async () => {
    buildDetails.mockResolvedValue({ ok: true, details })
    const own = vi.fn(async () => null)

    await expect(loadCheckDetailsWithProviderFallback(check(), own)).resolves.toBe(details)
    expect(own).not.toHaveBeenCalled()
  })

  it('does not fall back on a failure the user has to fix', async () => {
    buildDetails.mockResolvedValue({
      ok: false,
      reason: 'not-configured',
      serverUrl: 'https://ci.example.com',
      message: null
    })
    const own = vi.fn(async () => details)

    await expect(loadCheckDetailsWithProviderFallback(check(), own)).rejects.toThrow()
    expect(own).not.toHaveBeenCalled()
  })
})
