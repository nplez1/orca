import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from './ai-vault-types'
import { aiVaultSubagentParentKey, nestAiVaultSubagentSessions } from './ai-vault-subagent-nesting'

function session(fields: Partial<AiVaultSession> & { sessionId: string }): AiVaultSession {
  return {
    id: `local:pi:${fields.sessionId}:/pi/${fields.sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'pi',
    title: `Session ${fields.sessionId}`,
    cwd: '/Users/ada/repo/app',
    branch: null,
    model: 'deepseek-flash',
    filePath: `/Users/ada/.pi/agent/sessions/--repo--/${fields.sessionId}.jsonl`,
    codexHome: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:10:00.000Z',
    modifiedAt: '2026-05-01T10:10:00.000Z',
    messageCount: 2,
    totalTokens: 100,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `pi --session /pi/${fields.sessionId}.jsonl`,
    subagent: null,
    ...fields
  }
}

function child(sessionId: string, parentSessionId: string): AiVaultSession {
  return session({
    sessionId,
    subagent: { parentSessionId, agentType: 'Explore', status: null }
  })
}

function ids(sessions: readonly AiVaultSession[]): string[] {
  return sessions.map((entry) => entry.sessionId)
}

describe('nestAiVaultSubagentSessions', () => {
  it('moves a sub-agent row under its parent and keeps the parent top level', () => {
    const parent = session({ sessionId: 'parent' })
    const kids = [child('kid-a', 'parent'), child('kid-b', 'parent')]

    const nesting = nestAiVaultSubagentSessions([parent, ...kids])

    expect(ids(nesting.roots)).toEqual(['parent'])
    expect(ids(nesting.childrenByParentId.get(aiVaultSubagentParentKey(parent)) ?? [])).toEqual([
      'kid-a',
      'kid-b'
    ])
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('preserves the order the filtered list arrived in', () => {
    const nesting = nestAiVaultSubagentSessions([
      session({ sessionId: 'newest' }),
      child('kid', 'newest'),
      session({ sessionId: 'older' })
    ])

    expect(ids(nesting.roots)).toEqual(['newest', 'older'])
  })

  it('nests a sub-agent that spawned its own sub-agent', () => {
    const parent = session({ sessionId: 'parent' })
    const kid = child('kid', 'parent')
    const grandkid = child('grandkid', 'kid')

    const nesting = nestAiVaultSubagentSessions([parent, kid, grandkid])

    expect(ids(nesting.roots)).toEqual(['parent'])
    expect(ids(nesting.childrenByParentId.get(aiVaultSubagentParentKey(kid)) ?? [])).toEqual([
      'grandkid'
    ])
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('counts children whose parent is not in the list as hidden', () => {
    const nesting = nestAiVaultSubagentSessions([
      session({ sessionId: 'kept' }),
      child('orphan', 'not-loaded')
    ])

    expect(ids(nesting.roots)).toEqual(['kept'])
    expect(nesting.hiddenChildCount).toBe(1)
    expect(nesting.childrenByParentId.size).toBe(0)
  })

  it('does not nest across execution hosts or agents that reuse a session id', () => {
    const local = session({ sessionId: 'shared-id' })
    const remote = session({
      sessionId: 'shared-id',
      executionHostId: 'ssh:dev-box'
    })
    const otherAgentParent = session({ sessionId: 'shared-id', agent: 'claude' })
    const kid = child('kid', 'shared-id')

    const nesting = nestAiVaultSubagentSessions([local, remote, otherAgentParent, kid])

    // The pi child's parent id matches all three rows' ids; only the pi row on
    // the same host may claim it.
    expect(ids(nesting.roots)).toEqual(['shared-id', 'shared-id', 'shared-id'])
    expect(nesting.childrenByParentId.size).toBe(1)
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('nests a child whose parent belongs to a different agent', () => {
    // The case this exists for: a Claude conversation spawned by a pi session names that pi
    // session, so no Claude row carries the id and the same-agent reading cannot resolve it.
    const piParent = session({ sessionId: 'spawner', agent: 'pi' })
    const claudeChild = session({
      sessionId: 'child-conversation',
      agent: 'claude',
      subagent: { parentSessionId: 'spawner', agentType: null, status: null }
    })

    const nesting = nestAiVaultSubagentSessions([piParent, claudeChild])

    expect(ids(nesting.roots)).toEqual(['spawner'])
    expect(ids(nesting.childrenByParentId.get(aiVaultSubagentParentKey(piParent)) ?? [])).toEqual([
      'child-conversation'
    ])
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('shows a cross-agent child as a root when its parent is not in the list', () => {
    // Why: the usual filter is by agent, and a Claude-only view removes the pi parent — hiding the
    // conversation there would lose a real, resumable session.
    const orphan = session({
      sessionId: 'child-conversation',
      agent: 'claude',
      subagent: {
        parentSessionId: 'filtered-out',
        agentType: null,
        status: null,
        parentAgent: 'pi'
      }
    })

    const nesting = nestAiVaultSubagentSessions([orphan])

    expect(ids(nesting.roots)).toEqual(['child-conversation'])
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('will not pick a cross-agent parent when two rows share the id', () => {
    const claudeChild = session({
      sessionId: 'child-conversation',
      agent: 'claude',
      subagent: { parentSessionId: 'shared-id', agentType: null, status: null }
    })

    const nesting = nestAiVaultSubagentSessions([
      session({ sessionId: 'shared-id', agent: 'pi' }),
      session({ sessionId: 'shared-id', agent: 'codex' }),
      claudeChild
    ])

    expect(nesting.hiddenChildCount).toBe(1)
    expect(nesting.childrenByParentId.size).toBe(0)
  })

  it('shows a marked child as a root when the id is ambiguous', () => {
    // Why: two rows sharing the id means the link cannot be resolved, and a marked (cross-agent)
    // child is a real conversation — losing it from the list is worse than showing it unnested.
    const markedChild = session({
      sessionId: 'child-conversation',
      agent: 'claude',
      subagent: { parentSessionId: 'shared-id', agentType: null, status: null, parentAgent: 'pi' }
    })

    const nesting = nestAiVaultSubagentSessions([
      session({ sessionId: 'shared-id', agent: 'pi' }),
      session({ sessionId: 'shared-id', agent: 'codex' }),
      markedChild
    ])

    expect(ids(nesting.roots)).toEqual(['shared-id', 'shared-id', 'child-conversation'])
    expect(nesting.hiddenChildCount).toBe(0)
  })

  it('does not cross hosts to find a parent', () => {
    const claudeChild = session({
      sessionId: 'child-conversation',
      agent: 'claude',
      subagent: { parentSessionId: 'spawner', agentType: null, status: null }
    })

    const nesting = nestAiVaultSubagentSessions([
      session({ sessionId: 'spawner', agent: 'pi', executionHostId: 'ssh:dev-box' }),
      claudeChild
    ])

    expect(nesting.hiddenChildCount).toBe(1)
  })

  it('hides both halves of a parent cycle instead of expanding forever', () => {
    const nesting = nestAiVaultSubagentSessions([child('a', 'b'), child('b', 'a')])

    expect(nesting.roots).toEqual([])
    expect(nesting.childrenByParentId.size).toBe(0)
    expect(nesting.hiddenChildCount).toBe(2)
  })

  it('hides a transcript that names itself as its own parent', () => {
    const nesting = nestAiVaultSubagentSessions([child('self', 'self')])

    expect(nesting.roots).toEqual([])
    expect(nesting.hiddenChildCount).toBe(1)
  })

  it('leaves an empty list alone', () => {
    expect(nestAiVaultSubagentSessions([])).toEqual({
      roots: [],
      childrenByParentId: new Map(),
      hiddenChildCount: 0
    })
  })
})
