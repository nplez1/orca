import { describe, expect, it } from 'vitest'
import type { PRCheckDetail } from './github/check-types'
import { isGitHubRerunCandidate, isJenkinsCheck, selectRerunTargets } from './jenkins-rebuild'

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

describe('isJenkinsCheck', () => {
  it('needs a link that names a build, not just a `/job/` segment', () => {
    expect(isJenkinsCheck(jenkinsCheck())).toBe(true)
    expect(
      isJenkinsCheck(jenkinsCheck({ url: 'https://ci.example.com/job/repo/lastBuild/' }))
    ).toBe(true)
    expect(isJenkinsCheck(actionsCheck())).toBe(false)
    expect(isJenkinsCheck(jenkinsCheck({ url: 'https://ci.example.com/job/repo/' }))).toBe(false)
    expect(isJenkinsCheck(jenkinsCheck({ url: 'https://ci.example.com/job/repo/configure' }))).toBe(
      false
    )
    expect(isJenkinsCheck(check({ url: null }))).toBe(false)
  })
})

describe('isGitHubRerunCandidate', () => {
  it('counts a run id, a check run id or an Actions link', () => {
    expect(isGitHubRerunCandidate(actionsCheck())).toBe(true)
    expect(isGitHubRerunCandidate(check({ workflowRunId: 9 }))).toBe(true)
    expect(isGitHubRerunCandidate(check({ checkRunId: 9 }))).toBe(true)
    expect(isGitHubRerunCandidate(check({ url: null }))).toBe(false)
  })

  it('never counts a Jenkins check, however little else it carries', () => {
    expect(isGitHubRerunCandidate(jenkinsCheck())).toBe(false)
    // A Jenkins that publishes GitHub check runs carries an id, and rerequesting it starts a build
    // on the Jenkins side — so it belongs to the Jenkins half only.
    expect(isGitHubRerunCandidate(jenkinsCheck({ checkRunId: 42 }))).toBe(false)
  })
})

describe('selectRerunTargets', () => {
  it('splits a mixed failure list by the provider that owns each check', () => {
    const targets = selectRerunTargets({
      checks: [
        actionsCheck(),
        jenkinsCheck(),
        check({ name: 'passing', conclusion: 'success', workflowRunId: 3 })
      ],
      failedOnly: true
    })

    expect(targets.github).toHaveLength(1)
    expect(targets.jenkins).toHaveLength(1)
  })

  it('keeps every Jenkins build when the whole list is being rerun', () => {
    const targets = selectRerunTargets({
      checks: [
        jenkinsCheck(),
        jenkinsCheck({
          status: 'completed',
          url: 'https://ci.example.com/job/team/job/repo/11/'
        })
      ],
      failedOnly: false
    })

    expect(targets.jenkins).toHaveLength(2)
    expect(targets.github).toHaveLength(0)
  })

  it('drops a Jenkins build that is still running, in either mode', () => {
    for (const failedOnly of [true, false]) {
      const targets = selectRerunTargets({
        checks: [jenkinsCheck({ status: 'in_progress', conclusion: null })],
        failedOnly
      })

      expect(targets.jenkins).toHaveLength(0)
    }
  })

  it('counts one build once when two checks name it', () => {
    const targets = selectRerunTargets({
      checks: [
        jenkinsCheck(),
        // The same build through a Jenkins that also publishes a GitHub check run.
        jenkinsCheck({
          name: 'continuous-integration/jenkins/pr-merge (check run)',
          url: 'https://ci.example.com/job/team/job/repo/12/',
          checkRunId: 42
        })
      ],
      failedOnly: true
    })

    expect(targets.jenkins).toHaveLength(1)
    expect(targets.github).toHaveLength(0)
  })
})
