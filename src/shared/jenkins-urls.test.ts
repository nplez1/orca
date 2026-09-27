import { describe, expect, it } from 'vitest'
import {
  isJenkinsUrlUnderBase,
  normalizeJenkinsBaseUrl,
  parseJenkinsBuildLocation
} from './jenkins-urls'

describe('parseJenkinsBuildLocation classic URLs', () => {
  it('reads a plain build URL', () => {
    expect(parseJenkinsBuildLocation('https://ni.example.com/job/merge/1')).toEqual({
      serverUrl: 'https://ni.example.com',
      jobUrl: 'https://ni.example.com/job/merge/',
      buildUrl: 'https://ni.example.com/job/merge/1/',
      jobPath: ['merge'],
      buildNumber: 1,
      permalink: null
    })
  })

  it('ignores the page the status link happens to point at', () => {
    const expected = 'https://ci.example.com/job/build/17/'
    for (const page of [
      'display/redirect',
      'console',
      'consoleText?page=2',
      'artifact/report/index.html',
      'changes',
      'testReport/',
      'pipeline',
      'flowGraph',
      '#step-3'
    ]) {
      expect(
        parseJenkinsBuildLocation(`https://ci.example.com/job/build/17/${page}`)?.buildUrl
      ).toBe(expected)
    }
  })

  it('keeps every folder and multibranch segment', () => {
    const location = parseJenkinsBuildLocation(
      'https://ci.example.com/job/team/job/repo/job/main/12/console'
    )
    expect(location?.jobPath).toEqual(['team', 'repo', 'main'])
    expect(location?.buildUrl).toBe('https://ci.example.com/job/team/job/repo/job/main/12/')
  })

  it('keeps the path prefix Jenkins is served under', () => {
    const location = parseJenkinsBuildLocation('https://host.example.com/jenkins/job/foo/7/')
    expect(location?.serverUrl).toBe('https://host.example.com/jenkins')
    expect(location?.buildUrl).toBe('https://host.example.com/jenkins/job/foo/7/')
  })

  it('keeps a view prefix rather than treating it as the server root', () => {
    const location = parseJenkinsBuildLocation('https://host.example.com/view/All/job/foo/7/')
    expect(location?.jobUrl).toBe('https://host.example.com/view/All/job/foo/')
    expect(location?.buildNumber).toBe(7)
  })

  it('falls back to the newest build for a job-level link', () => {
    expect(parseJenkinsBuildLocation('https://ci.example.com/job/foo/')).toMatchObject({
      buildUrl: 'https://ci.example.com/job/foo/lastBuild/',
      buildNumber: null,
      permalink: 'lastBuild'
    })
  })

  it('honours a permalink alias', () => {
    expect(
      parseJenkinsBuildLocation('https://ci.example.com/job/foo/lastSuccessfulBuild/console')
    ).toMatchObject({
      buildUrl: 'https://ci.example.com/job/foo/lastSuccessfulBuild/',
      buildNumber: null,
      permalink: 'lastSuccessfulBuild'
    })
  })

  it('reads a job actually named lastBuild as a job, not an alias', () => {
    expect(parseJenkinsBuildLocation('https://ci.example.com/job/lastBuild/')).toMatchObject({
      jobPath: ['lastBuild'],
      buildNumber: null,
      permalink: 'lastBuild'
    })
    expect(parseJenkinsBuildLocation('https://ci.example.com/job/lastBuild/9/')).toMatchObject({
      jobPath: ['lastBuild'],
      buildNumber: 9,
      permalink: null
    })
  })

  it('round-trips an encoded job name', () => {
    expect(parseJenkinsBuildLocation('https://ci.example.com/job/foo%20bar/3/')).toMatchObject({
      jobPath: ['foo bar'],
      buildUrl: 'https://ci.example.com/job/foo%20bar/3/'
    })
  })

  it('rejects links that are not Jenkins builds', () => {
    for (const input of [
      'https://github.com/stablyai/orca/actions/runs/123',
      'https://github.com/stablyai/orca/pull/42/checks',
      'https://example.com/job',
      'https://example.com/jobs/merge/1',
      'ftp://ci.example.com/job/foo/1/',
      'not a url',
      '',
      null,
      undefined
    ]) {
      expect(parseJenkinsBuildLocation(input)).toBeNull()
    }
  })
})

describe('parseJenkinsBuildLocation Blue Ocean URLs', () => {
  it('maps a non-multibranch pipeline that repeats its name under /detail/', () => {
    expect(
      parseJenkinsBuildLocation(
        'https://ci.example.com/blue/organizations/jenkins/deploy/detail/deploy/12/pipeline'
      )
    ).toMatchObject({
      jobPath: ['deploy'],
      buildNumber: 12,
      buildUrl: 'https://ci.example.com/job/deploy/12/'
    })
  })

  it('reads the branch from /detail/ for a multibranch pipeline', () => {
    expect(
      parseJenkinsBuildLocation(
        'https://ci.example.com/blue/organizations/jenkins/repo/detail/main/12/pipeline'
      )
    ).toMatchObject({
      jobPath: ['repo', 'main'],
      buildUrl: 'https://ci.example.com/job/repo/job/main/12/'
    })
  })

  it('splits an encoded folder path and keeps the prefix Jenkins is served under', () => {
    expect(
      parseJenkinsBuildLocation(
        'https://host.example.com/jenkins/blue/organizations/jenkins/team%2Frepo/detail/main/12/pipeline'
      )
    ).toMatchObject({
      jobPath: ['team', 'repo', 'main'],
      buildUrl: 'https://host.example.com/jenkins/job/team/job/repo/job/main/12/'
    })
  })

  it('falls back to the newest build for an activity link', () => {
    expect(
      parseJenkinsBuildLocation(
        'https://ci.example.com/blue/organizations/jenkins/repo/branches/main/activity'
      )
    ).toMatchObject({
      jobPath: ['repo', 'main'],
      buildNumber: null,
      permalink: 'lastBuild',
      buildUrl: 'https://ci.example.com/job/repo/job/main/lastBuild/'
    })
  })
})

describe('normalizeJenkinsBaseUrl', () => {
  it('drops trailing slashes, query and fragment', () => {
    expect(normalizeJenkinsBaseUrl(' https://ci.example.com/jenkins/// ')).toBe(
      'https://ci.example.com/jenkins'
    )
    expect(normalizeJenkinsBaseUrl('https://ci.example.com/jenkins?x=1#y')).toBe(
      'https://ci.example.com/jenkins'
    )
    expect(normalizeJenkinsBaseUrl('https://ci.example.com/')).toBe('https://ci.example.com')
  })

  it('rejects values that cannot address a server', () => {
    for (const input of ['ci.example.com', 'ftp://ci.example.com', '', '   ', null]) {
      expect(normalizeJenkinsBaseUrl(input)).toBeNull()
    }
  })
})

describe('isJenkinsUrlUnderBase', () => {
  it('matches on path-segment boundaries, not raw text', () => {
    expect(isJenkinsUrlUnderBase('https://host/jenkins', 'https://host/jenkins/job/a/1/')).toBe(
      true
    )
    expect(isJenkinsUrlUnderBase('https://host/jenkins/', 'https://host/jenkins')).toBe(true)
    expect(isJenkinsUrlUnderBase('https://host/jenkins', 'https://host/jenkins-old/job/a/1/')).toBe(
      false
    )
  })

  it('lets a bare origin serve the whole host and nothing else', () => {
    expect(isJenkinsUrlUnderBase('https://host', 'https://host/job/a/1/')).toBe(true)
    expect(isJenkinsUrlUnderBase('https://host', 'https://other/job/a/1/')).toBe(false)
    expect(isJenkinsUrlUnderBase('https://host', 'http://host/job/a/1/')).toBe(false)
  })
})
