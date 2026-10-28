import { beforeEach, describe, expect, it } from 'vitest'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { PR_CHECKS_CACHE_TTL_MS } from '@/store/github/cache-identity'
import {
  checkDetailsBuildIdentity,
  checkDetailsNeedRefresh,
  clearCheckDetailsCache,
  readCachedCheckDetails,
  rememberCheckDetails,
  type CheckDetailsCacheEntry
} from './check-details-cache'

const check = (overrides: Partial<PRCheckDetail> = {}): PRCheckDetail => ({
  name: 'unit',
  status: 'in_progress',
  conclusion: null,
  url: null,
  checkRunId: 42,
  ...overrides
})

const details = (
  status: PRCheckRunDetails['status'],
  conclusion: PRCheckRunDetails['conclusion']
): PRCheckRunDetails => ({
  name: 'unit',
  status,
  conclusion,
  url: null,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  title: 'Unit tests',
  summary: null,
  text: null,
  annotations: [],
  jobs: []
})

const entry = (
  status: PRCheckDetail['status'],
  conclusion: PRCheckDetail['conclusion'],
  fetchedAt = Date.now()
): CheckDetailsCacheEntry => ({
  data: details(status, conclusion),
  fetchedAt,
  readFor: { status, conclusion }
})

const running = { status: 'in_progress', conclusion: null } as const
const finished = { status: 'completed', conclusion: 'failure' } as const

describe('checkDetailsNeedRefresh', () => {
  it('reads a build nothing has been read for yet', () => {
    expect(checkDetailsNeedRefresh(undefined, check())).toBe(true)
  })

  it('leaves a read that is already in flight alone', () => {
    expect(checkDetailsNeedRefresh({ loading: true, details: null }, check())).toBe(false)
  })

  it('keeps a payload on screen while the row has not moved', () => {
    expect(
      checkDetailsNeedRefresh(
        {
          loading: false,
          details: details('in_progress', null),
          readAt: Date.now(),
          readFor: running
        },
        check()
      )
    ).toBe(false)
  })

  it('reads again once a still-running build outlives the checks TTL', () => {
    expect(
      checkDetailsNeedRefresh(
        {
          loading: false,
          details: details('in_progress', null),
          readAt: Date.now() - PR_CHECKS_CACHE_TTL_MS - 1,
          readFor: running
        },
        check()
      )
    ).toBe(true)
  })

  it('never re-reads a finished build, however old the payload is', () => {
    expect(
      checkDetailsNeedRefresh(
        { loading: false, details: details('completed', 'failure'), readAt: 0, readFor: finished },
        check(finished)
      )
    ).toBe(false)
  })

  it('reads again when the row moved since the payload was read', () => {
    expect(
      checkDetailsNeedRefresh(
        {
          loading: false,
          details: details('in_progress', null),
          readAt: Date.now(),
          readFor: running
        },
        check(finished)
      )
    ).toBe(true)
  })

  it('does not poll a failed read for a row that has not moved', () => {
    expect(
      checkDetailsNeedRefresh({ loading: false, details: null, readFor: running }, check())
    ).toBe(false)
    expect(
      checkDetailsNeedRefresh({ loading: false, details: null, readFor: running }, check(finished))
    ).toBe(true)
  })
})

describe('the shared check details cache', () => {
  beforeEach(() => {
    clearCheckDetailsCache()
  })

  it('keys a payload by the build the check describes', () => {
    expect(checkDetailsBuildIdentity(check())).toBe('check-run:42')
    expect(checkDetailsBuildIdentity(check({ checkRunId: undefined, workflowRunId: 7 }))).toBe(
      'workflow-run:7'
    )
    expect(checkDetailsBuildIdentity(check({ checkRunId: undefined, gitlabJobId: 9 }))).toBe(
      'gitlab-job:9'
    )
    expect(
      checkDetailsBuildIdentity(
        check({ checkRunId: undefined, url: 'https://ci.example.com/j/12/' })
      )
    ).toBe('url:https://ci.example.com/j/12/')
    expect(checkDetailsBuildIdentity(check({ checkRunId: undefined }))).toBe('name:unit')
  })

  it('hands a payload one surface read to the other', () => {
    rememberCheckDetails(check(), entry('in_progress', null, 12))

    expect(readCachedCheckDetails(check({ name: 'reported under another name' }))).toEqual(
      entry('in_progress', null, 12)
    )
    expect(readCachedCheckDetails(check({ checkRunId: 43 }))).toBeUndefined()
  })

  it('forgets everything a suite seeded', () => {
    rememberCheckDetails(check(), entry('in_progress', null))
    clearCheckDetailsCache()

    expect(readCachedCheckDetails(check())).toBeUndefined()
  })
})
