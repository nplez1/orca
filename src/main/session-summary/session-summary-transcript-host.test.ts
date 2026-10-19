import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { isSessionSummaryHostSupported } from '../../shared/session-summary-host'
import { resolveSessionSummaryTranscriptHost } from './session-summary-transcript-host'

describe('resolveSessionSummaryTranscriptHost', () => {
  it('defaults to this machine when nothing names a host', () => {
    expect(resolveSessionSummaryTranscriptHost({})).toEqual({ kind: 'local' })
    expect(resolveSessionSummaryTranscriptHost({ requestedHostId: 'local' })).toEqual({
      kind: 'local'
    })
  })

  it('takes an SSH workspace as the host to read from', () => {
    expect(resolveSessionSummaryTranscriptHost({ requestedHostId: 'ssh:target-1' })).toEqual({
      kind: 'ssh',
      hostId: 'ssh:target-1',
      targetId: 'target-1'
    })
  })

  // A remote hook row is ingested with the connection it arrived on, and its transcript
  // path only means anything on that machine — stronger evidence than the request.
  it('prefers the connection the status row arrived on', () => {
    expect(
      resolveSessionSummaryTranscriptHost({
        requestedHostId: 'ssh:somewhere-else',
        connectionId: 'target-1'
      })
    ).toEqual({
      kind: 'ssh',
      hostId: toSshExecutionHostId('target-1'),
      targetId: 'target-1'
    })
  })

  it('reads a paired host as a runtime host with its environment id', () => {
    expect(resolveSessionSummaryTranscriptHost({ requestedHostId: 'runtime:env%2F1' })).toEqual({
      kind: 'runtime',
      hostId: 'runtime:env%2F1',
      environmentId: 'env/1'
    })
  })

  // A newer host kind is not local: opening its path here would claim the session lives
  // on this machine, which is exactly the wrong empty state #135 is about.
  it('refuses a host id it cannot parse', () => {
    expect(resolveSessionSummaryTranscriptHost({ requestedHostId: 'cloud:abc' })).toEqual({
      kind: 'unsupported',
      hostId: 'cloud:abc'
    })
  })
})

describe('isSessionSummaryHostSupported', () => {
  it('supports every host kind this build can name', () => {
    expect(isSessionSummaryHostSupported(null)).toBe(true)
    expect(isSessionSummaryHostSupported('local')).toBe(true)
    expect(isSessionSummaryHostSupported('ssh:target-1')).toBe(true)
    // A paired host folds its own sessions, so it is supported too.
    expect(isSessionSummaryHostSupported('runtime:env-1')).toBe(true)
  })

  it('does not treat an unparseable host as usable', () => {
    expect(isSessionSummaryHostSupported('cloud:abc')).toBe(false)
  })
})
