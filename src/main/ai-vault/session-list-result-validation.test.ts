import { describe, expect, it } from 'vitest'
import { parseAiVaultListResult } from './session-list-result-validation'

describe('parseAiVaultListResult', () => {
  it('keeps host cwd aliases, and drops only malformed ones', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        { ...validSession('aliased'), cwdAliases: ['/home/me/work/api'] },
        { ...validSession('malformed'), cwdAliases: [42] }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions.map((entry) => [entry.sessionId, entry.cwdAliases])).toEqual([
      ['aliased', ['/home/me/work/api']],
      ['malformed', undefined]
    ])
  })

  it('keeps valid sessions when another wire entry is malformed', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession(), { id: 42 }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.sessionId).toBe('session-1')
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        path: 'aiVault.listSessions',
        message: expect.stringContaining('Skipped 1 invalid')
      })
    )
  })

  it('keeps known-agent sessions while silently dropping unknown-agent rows', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession(), { ...validSession('session-new'), agent: 'future-agent' }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'a'.repeat(64)
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]?.agent).toBe('codex')
    expect(parsed.sessions[0]?.sessionId).toBe('session-1')
    expect(parsed.issues).toEqual([])
    // Why the fingerprint stays: a row from an agent this build does not know is a build-version
    // gap, and dropping the fingerprint would switch off the diff for the whole host. The row is
    // reported by the agent list instead of by a listing error.
    expect(parsed.fingerprint).toBe('a'.repeat(64))
  })

  it('keeps the fingerprint when every row was readable', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'a'.repeat(64)
    })

    expect(parsed.fingerprint).toBe('a'.repeat(64))
  })

  it('keeps known scan issues while silently dropping unknown-agent issues', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [validScanIssue(), validScanIssue('future-agent')],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([validScanIssue()])
  })

  it('reports malformed scan issues without counting unknown-agent issues as invalid', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [validScanIssue(), { agent: 'future-agent' }, validScanIssue('newer-agent')],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([
      validScanIssue(),
      expect.objectContaining({
        path: 'aiVault.listSessions',
        message: expect.stringContaining('Skipped 1 invalid')
      })
    ])
  })

  it('does not throw when malformed rows are mixed with well-formed unknown sessions', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        { ...validSession('malformed-future'), agent: 'future-agent', messageCount: 'invalid' },
        { ...validSession('valid-future'), agent: 'newer-agent' }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toEqual([])
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        path: 'aiVault.listSessions',
        message: expect.stringContaining('Skipped 1 invalid')
      })
    )
  })

  it('preserves the optional session fields the panel renders', () => {
    const parsed = parseAiVaultListResult({
      sessions: [
        {
          ...validSession(),
          previewMessagesTruncated: true,
          firstUserPrompt: 'first',
          lastUserPrompt: 'last'
        }
      ],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions[0]).toMatchObject({
      previewMessagesTruncated: true,
      firstUserPrompt: 'first',
      lastUserPrompt: 'last'
    })
  })

  it('keeps an issue whose kind this build does not know, as its own kinded row', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [
        {
          agent: 'opencode',
          kind: 'source-from-a-newer-host',
          path: '/home/ada/.local/share/opencode/opencode.db',
          message: 'OpenCode history was skipped.'
        }
      ],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([
      expect.objectContaining({ kind: 'scope', message: 'OpenCode history was skipped.' })
    ])
    expect(parsed.issues.some((issue) => issue.message.includes('invalid'))).toBe(false)
  })

  it('carries issue copy codes from a remote host and drops only malformed ones', () => {
    const coded = {
      agent: 'codex',
      path: '\\\\wsl.localhost\\Ubuntu',
      message: 'English',
      messageCode: 'wslDistroNotRunning',
      messageParams: { distro: 'Ubuntu' }
    }
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [coded, { ...coded, messageCode: 7, messageParams: { distro: {} } }],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues).toEqual([coded, { agent: 'codex', path: coded.path, message: 'English' }])
  })

  it('leaves an unkinded issue unkinded so real skipped transcripts still count', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [{ agent: 'codex', path: '/bad.jsonl', message: 'Malformed transcript' }],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.issues[0]?.kind).toBeUndefined()
  })

  it('rejects a malformed result envelope', () => {
    expect(() => parseAiVaultListResult({ sessions: [] })).toThrow()
  })

  it('rejects a nonempty sessions array when every row is invalid', () => {
    expect(() =>
      parseAiVaultListResult({
        sessions: [{ id: 42 }, null],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z'
      })
    ).toThrow('all supplied Agent Session History sessions were invalid')
  })
})

// Rolling upgrades are the normal state: a released host may answer this build
// with a row it produced before the index-backed list, and a newer host may add
// fields this build's schema has never heard of. Either one must degrade the row,
// never the whole list — see docs/reference/remote-wire-compatibility.md.
describe('parseAiVaultListResult cross-version skew', () => {
  it('accepts a pre-change host row and keeps every field the client reads', () => {
    const row = preChangeSession()
    const parsed = parseAiVaultListResult({
      sessions: [row],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]).toMatchObject({
      id: row.id,
      executionHostId: 'local',
      agent: 'codex',
      sessionId: 'session-1',
      title: 'Session one',
      cwd: '/repo',
      branch: null,
      model: null,
      filePath: '/tmp/session-1.jsonl',
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-07-27T00:00:00.000Z',
      messageCount: 1,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: 'codex resume session-1',
      subagent: null
    })
  })

  it('ignores row and envelope fields a newer host added instead of rejecting them', () => {
    // `generation` and `cancelled` stand in for any future additive field: a zod
    // object strips unknown keys, so the known projection survives untouched.
    const parsed = parseAiVaultListResult({
      sessions: [{ ...validSession(), generation: 7 }],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      cancelled: true,
      generation: 7
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]).not.toHaveProperty('generation')
    expect(parsed).not.toHaveProperty('generation')
    expect(parsed.issues).toEqual([])
  })
})

function preChangeSession(): Record<string, unknown> {
  // The pre-change row shape. `executionHostId` is required by every released
  // validator this worktree can pair against (v1.4.184 onward), so an old host
  // always stamps it.
  return {
    id: 'local:codex:session-1:/tmp/session-1.jsonl',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Session one',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/session-1.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume session-1',
    subagent: null
  }
}

function validSession(sessionId = 'session-1'): Record<string, unknown> {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: 'Session one',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

describe('parseAiVaultListResult paging and deltas', () => {
  it('keeps a bounded page cursor and its fingerprint', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      hasMore: true,
      nextOffset: 1
    })

    expect(parsed).toMatchObject({ hasMore: true, nextOffset: 1, fingerprint: 'a'.repeat(64) })
  })

  it('rejects a page that claims more rows without a cursor', () => {
    expect(() =>
      parseAiVaultListResult({
        sessions: [validSession()],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z',
        hasMore: true
      })
    ).toThrow('Invalid paged response')
  })

  it('parses a delta and drops only its malformed rows', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'b'.repeat(64),
      syncDelta: { upserts: [validSession('session-2'), { id: 42 }], removedIds: ['gone'] }
    })

    expect(parsed.syncDelta).toEqual({
      upserts: [expect.objectContaining({ sessionId: 'session-2' })],
      removedIds: ['gone']
    })
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Skipped 1 invalid') })
    )
  })

  it('drops a delta row this build cannot read instead of leaving the old one in place', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'b'.repeat(64),
      syncDelta: {
        upserts: [
          {
            ...validSession('session-2'),
            previewMessages: [{ role: 'future-role', text: 'x', timestamp: null }]
          }
        ],
        removedIds: []
      }
    })

    // Keeping the row this client already holds would show stale data under the new fingerprint,
    // and the host would never send it again because its digest did not change.
    expect(parsed.syncDelta).toEqual({
      upserts: [],
      removedIds: [validSession('session-2').id]
    })
    // The body is still the host's list minus the row this build cannot show, so an `unchanged`
    // reply can still be honoured against it. (The leg declines to *diff* such a body.)
    expect(parsed.fingerprint).toBe('b'.repeat(64))
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Skipped 1 invalid') })
    )
  })

  it('drops the fingerprint when a rejected delta row cannot be named', () => {
    const parsed = parseAiVaultListResult({
      sessions: [],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      fingerprint: 'b'.repeat(64),
      syncDelta: { upserts: [{ id: 42 }], removedIds: [] }
    })

    // The held list cannot be corrected by id, so the body no longer matches this fingerprint.
    expect(parsed.syncDelta).toEqual({ upserts: [], removedIds: [] })
    expect(parsed.fingerprint).toBeUndefined()
  })

  it('counts an unreadable later page instead of failing the whole listing', () => {
    const parsed = parseAiVaultListResult(
      {
        sessions: [{ id: 42 }],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z'
      },
      { offset: 2 }
    )

    // A page this build cannot read must cost that page's rows, not every page after it.
    expect(parsed.sessions).toEqual([])
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Skipped 1 invalid') })
    )
  })

  it('reports an unreadable first page instead of failing the whole listing', () => {
    const parsed = parseAiVaultListResult(
      { sessions: [{ id: 42 }], issues: [], scannedAt: '2026-07-27T00:00:00.000Z' },
      { offset: 0 }
    )

    // A page whose rows all use a value this build does not know is version skew, not a broken
    // reply: the readable pages after it still arrive.
    expect(parsed.sessions).toEqual([])
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Skipped 1 invalid') })
    )
  })

  it('still refuses a single reply made entirely of unreadable rows', () => {
    expect(() =>
      parseAiVaultListResult({ sessions: [{ id: 42 }], issues: [], scannedAt: 'x' })
    ).toThrow('all supplied Agent Session History sessions were invalid')
  })

  it('rejects a reply that carries both a delta and a listing body', () => {
    expect(() =>
      parseAiVaultListResult({
        sessions: [validSession()],
        issues: [],
        scannedAt: '2026-07-27T00:00:00.000Z',
        syncDelta: { upserts: [], removedIds: [] }
      })
    ).toThrow('Invalid session delta response')
  })
})

function validScanIssue(agent = 'codex'): Record<string, unknown> {
  return {
    agent,
    path: '/tmp/sessions',
    message: 'permission denied'
  }
}
