import { describe, expect, it } from 'vitest'
import { aiVaultSearchHit } from '../../shared/ai-vault-search-test-fixture'
import { SESSION_SEARCH_FUSION_K, fuseHostRankings } from './session-search-rank-fusion'

const RANK_ONE = 1 / (SESSION_SEARCH_FUSION_K + 1)

describe('reciprocal rank fusion', () => {
  it('sums reciprocal ranks across hosts, so one deep rank can outrank a shallow one', () => {
    const fused = fuseHostRankings([
      { executionHostId: 'ssh:alpha', hits: [aiVaultSearchHit({ sessionId: 'shared' })] },
      {
        executionHostId: 'ssh:beta',
        hits: [
          aiVaultSearchHit({ sessionId: 'beta-only' }),
          aiVaultSearchHit({ sessionId: 'shared' })
        ]
      }
    ])

    // 1/61 + 1/62 beats the single rank-one contribution from another corpus.
    expect(fused.map((hit) => hit.sessionId)).toEqual(['shared', 'beta-only'])
    expect(fused[0]?.score).toBeCloseTo(RANK_ONE + 1 / (SESSION_SEARCH_FUSION_K + 2))
    expect(fused[1]?.score).toBeCloseTo(RANK_ONE)
  })

  it('orders equal scores by updatedAt, then host, then session id', () => {
    const fused = fuseHostRankings([
      {
        executionHostId: 'ssh:beta',
        hits: [aiVaultSearchHit({ sessionId: 'b', updatedAt: '2024-02-01T00:00:00.000Z' })]
      },
      {
        executionHostId: 'ssh:alpha',
        hits: [aiVaultSearchHit({ sessionId: 'a', updatedAt: '2024-03-01T00:00:00.000Z' })]
      },
      {
        executionHostId: 'ssh:gamma',
        hits: [aiVaultSearchHit({ sessionId: 'g', updatedAt: '2024-02-01T00:00:00.000Z' })]
      },
      // No timestamp sorts last rather than being dropped or throwing off the order.
      {
        executionHostId: 'ssh:delta',
        hits: [aiVaultSearchHit({ sessionId: 'd', updatedAt: null })]
      }
    ])

    expect(fused.map((hit) => hit.sessionId)).toEqual(['a', 'b', 'g', 'd'])
  })

  it('keeps the order total when score and time tie', () => {
    const fused = fuseHostRankings([
      {
        executionHostId: 'ssh:zeta',
        hits: [aiVaultSearchHit({ sessionId: 'z', cwd: '/work/z' })]
      },
      {
        executionHostId: 'ssh:alpha',
        hits: [aiVaultSearchHit({ sessionId: 'a', cwd: '/work/a' })]
      }
    ])

    expect(fused.map((hit) => hit.executionHostId)).toEqual(['ssh:alpha', 'ssh:zeta'])
  })

  it('dedupes after fusion on agent, session id and cwd, preferring a present source', () => {
    const fused = fuseHostRankings([
      {
        executionHostId: 'ssh:beta',
        hits: [
          aiVaultSearchHit({
            sessionId: 'one-transcript',
            cwd: '/work/repo',
            source: { presence: 'missing' }
          })
        ]
      },
      {
        executionHostId: 'ssh:alpha',
        hits: [
          aiVaultSearchHit({
            sessionId: 'one-transcript',
            cwd: '/work/repo',
            source: { presence: 'present', filePath: '/work/repo/session.jsonl' }
          })
        ]
      }
    ])

    expect(fused).toHaveLength(1)
    expect(fused[0]?.executionHostId).toBe('ssh:alpha')
    expect(fused[0]?.source).toMatchObject({ presence: 'present' })
    // Both legs still contributed a rank to the surviving row.
    expect(fused[0]?.score).toBeCloseTo(RANK_ONE * 2)
  })

  it('prefers this desktop over another host when both sources are present', () => {
    const fused = fuseHostRankings([
      {
        executionHostId: 'ssh:alpha',
        hits: [aiVaultSearchHit({ sessionId: 'shared-home', cwd: '/home/me/repo' })]
      },
      {
        executionHostId: 'local',
        hits: [aiVaultSearchHit({ sessionId: 'shared-home', cwd: '/home/me/repo' })]
      }
    ])

    expect(fused).toHaveLength(1)
    expect(fused[0]?.executionHostId).toBe('local')
  })

  it('does not dedupe one transcript seen under two cwd spellings', () => {
    const fused = fuseHostRankings([
      {
        executionHostId: 'runtime:wsl-view',
        hits: [aiVaultSearchHit({ sessionId: 'same-id', cwd: '/mnt/c/Users/me/repo' })]
      },
      {
        executionHostId: 'ssh:windows-view',
        hits: [aiVaultSearchHit({ sessionId: 'same-id', cwd: 'C:\\Users\\me\\repo' })]
      }
    ])

    // A documented limitation, not a silent merge into one wrong row.
    expect(fused).toHaveLength(2)
  })

  it('stamps the host each surviving row came from', () => {
    const fused = fuseHostRankings([
      { executionHostId: 'ssh:alpha', hits: [aiVaultSearchHit({ sessionId: 'a' })] },
      { executionHostId: 'ssh:beta', hits: [aiVaultSearchHit({ sessionId: 'b' })] }
    ])

    expect(fused.map((hit) => [hit.sessionId, hit.executionHostId])).toEqual([
      ['a', 'ssh:alpha'],
      ['b', 'ssh:beta']
    ])
  })

  it('returns nothing for no legs', () => {
    expect(fuseHostRankings([])).toEqual([])
  })
})
