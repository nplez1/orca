import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSubagentParentKey } from '../../../../shared/ai-vault-subagent-nesting'
import type { AiVaultSessionListGroup } from './ai-vault-session-filters'
import { buildVaultListRows, type AiVaultListRow } from './ai-vault-virtual-rows'

function session(sessionId: string, parentSessionId?: string): AiVaultSession {
  return {
    id: `local:pi:${sessionId}:/pi/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'pi',
    sessionId,
    title: `Session ${sessionId}`,
    cwd: '/Users/ada/repo/app',
    branch: null,
    model: 'deepseek-flash',
    filePath: `/Users/ada/.pi/agent/sessions/--repo--/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:10:00.000Z',
    modifiedAt: '2026-05-01T10:10:00.000Z',
    messageCount: 2,
    totalTokens: 100,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `pi --session /pi/${sessionId}.jsonl`,
    subagent: parentSessionId ? { parentSessionId, agentType: 'Explore', status: null } : null
  }
}

function group(sessions: readonly AiVaultSession[]): AiVaultSessionListGroup {
  return { key: 'group-a', label: 'repo', sessions: [...sessions] }
}

function childrenMap(
  parent: AiVaultSession,
  children: readonly AiVaultSession[]
): ReadonlyMap<string, readonly AiVaultSession[]> {
  return new Map([[aiVaultSubagentParentKey(parent), children]])
}

describe('buildVaultListRows', () => {
  it('lists a collapsed parent without its sub-agent rows', () => {
    const parent = session('parent')
    const children = [session('kid-a', 'parent'), session('kid-b', 'parent')]

    const rows = buildVaultListRows({
      groups: [group([parent])],
      collapsedGroups: new Set(),
      childrenByParentId: childrenMap(parent, children),
      expandedSubagentParentIds: new Set()
    })

    expect(rows).toEqual([
      { type: 'group', group: { key: 'group-a', label: 'repo', sessions: [parent] } },
      {
        type: 'session',
        groupKey: 'group-a',
        session: parent,
        subagentDepth: 0,
        subagentChildCount: 2,
        subagentChildrenExpanded: false
      }
    ])
  })

  it('unfolds an expanded parent\u2019s sub-agent rows beneath it', () => {
    const parent = session('parent')
    const children = [session('kid-a', 'parent'), session('kid-b', 'parent')]

    const rows = buildVaultListRows({
      groups: [group([parent])],
      collapsedGroups: new Set(),
      childrenByParentId: childrenMap(parent, children),
      expandedSubagentParentIds: new Set([parent.id])
    })

    expect(rows.map((row) => (row.type === 'session' ? row.session.sessionId : 'header'))).toEqual([
      'header',
      'parent',
      'kid-a',
      'kid-b'
    ])
    const kidRows = rows.filter(
      (row): row is Extract<AiVaultListRow, { type: 'session' }> =>
        row.type === 'session' && row.subagentDepth > 0
    )
    expect(kidRows).toHaveLength(2)
    expect(kidRows.every((row) => row.subagentChildrenExpanded === false)).toBe(true)
  })

  it('nests a sub-agent that has its own sub-agent', () => {
    const parent = session('parent')
    const kid = session('kid', 'parent')
    const grandkid = session('grandkid', 'kid')
    const nested = new Map([
      [aiVaultSubagentParentKey(parent), [kid]],
      [aiVaultSubagentParentKey(kid), [grandkid]]
    ])

    const rows = buildVaultListRows({
      groups: [group([parent])],
      collapsedGroups: new Set(),
      childrenByParentId: nested,
      expandedSubagentParentIds: new Set([parent.id, kid.id])
    })

    expect(
      rows
        .filter((row) => row.type === 'session')
        .map((row) => (row.type === 'session' ? [row.session.sessionId, row.subagentDepth] : null))
    ).toEqual([
      ['parent', 0],
      ['kid', 1],
      ['grandkid', 2]
    ])
  })

  it('keeps only the header of a collapsed group', () => {
    const rows = buildVaultListRows({
      groups: [group([session('a'), session('b')])],
      collapsedGroups: new Set(['group-a']),
      childrenByParentId: new Map(),
      expandedSubagentParentIds: new Set()
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('group')
  })

  it('reports no children for an ordinary session', () => {
    const rows = buildVaultListRows({
      groups: [group([session('solo')])],
      collapsedGroups: new Set(),
      childrenByParentId: new Map(),
      expandedSubagentParentIds: new Set()
    })

    const row = rows.find((entry) => entry.type === 'session')
    expect(row?.type === 'session' && row.subagentChildCount).toBe(0)
  })

  it('stops unfolding a chain that is deeper than the indent cap', () => {
    const root = session('depth-0')
    const descendants = Array.from({ length: 11 }, (_, index) => session(`depth-${index + 1}`))
    const chain = [root, ...descendants]
    const nested = new Map<string, readonly AiVaultSession[]>()
    for (const [index, current] of descendants.entries()) {
      const previous = chain[index]
      if (previous) {
        nested.set(aiVaultSubagentParentKey(previous), [current])
      }
    }

    const rows = buildVaultListRows({
      groups: [group([root])],
      collapsedGroups: new Set(),
      childrenByParentId: nested,
      expandedSubagentParentIds: new Set(chain.map((entry) => entry.id))
    })

    const depths = rows.flatMap((row) => (row.type === 'session' ? [row.subagentDepth] : []))
    expect(Math.max(...depths)).toBe(8)
    expect(depths).toHaveLength(9)
  })
})
