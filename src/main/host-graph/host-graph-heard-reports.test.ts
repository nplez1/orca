import { describe, expect, it } from 'vitest'
import {
  HOST_GRAPH_MAX_HEARD,
  HOST_GRAPH_NODE_TTL_MS,
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency
} from '../../shared/host-graph/host-graph-contract'
import { hostGraphRevision } from '../../shared/host-graph/host-graph-compose'
import { createHostGraphHeardReports } from './host-graph-heard-reports'

const NOW = 1_700_000_000_000

function adjacency(label: string): HostGraphAdjacency {
  const self = { ref: { orcaHostKey: `${label}-key` }, label }
  return {
    version: HOST_GRAPH_PAYLOAD_VERSION,
    self,
    edges: [],
    revision: hostGraphRevision({ self, edges: [] }),
    generatedAt: NOW
  }
}

describe('createHostGraphHeardReports', () => {
  it('drops a report once it is older than the node TTL', () => {
    const heard = createHostGraphHeardReports({ now: () => NOW })
    heard.record({ callerFingerprint: 'caller-a', adjacency: adjacency('a'), receivedAt: NOW })

    expect(heard.list({ now: NOW + HOST_GRAPH_NODE_TTL_MS })).toHaveLength(1)
    expect(heard.list({ now: NOW + HOST_GRAPH_NODE_TTL_MS + 1 })).toEqual([])
  })

  it('keeps the newest reports when callers outnumber the cap', () => {
    const heard = createHostGraphHeardReports({ now: () => NOW })
    for (let index = 0; index < HOST_GRAPH_MAX_HEARD + 1; index += 1) {
      heard.record({
        callerFingerprint: `caller-${index}`,
        adjacency: adjacency(`host ${index}`),
        receivedAt: NOW - index
      })
    }

    const listed = heard.list({ now: NOW })
    expect(listed).toHaveLength(HOST_GRAPH_MAX_HEARD)
    expect(listed[0]).toMatchObject({ reportedBy: 'caller-0', receivedAt: NOW })
    expect(listed.map((report) => report.reportedBy)).not.toContain(
      `caller-${HOST_GRAPH_MAX_HEARD}`
    )
  })

  it('answers newest first', () => {
    const heard = createHostGraphHeardReports({ now: () => NOW })
    heard.record({ callerFingerprint: 'older', adjacency: adjacency('older'), receivedAt: NOW - 5 })
    heard.record({ callerFingerprint: 'newer', adjacency: adjacency('newer'), receivedAt: NOW - 1 })

    expect(heard.list({ now: NOW }).map((report) => report.reportedBy)).toEqual(['newer', 'older'])
  })

  it('replaces a caller report rather than accumulating one per exchange', () => {
    const heard = createHostGraphHeardReports({ now: () => NOW })
    heard.record({
      callerFingerprint: 'caller-a',
      adjacency: adjacency('before'),
      receivedAt: NOW - 5
    })
    heard.record({ callerFingerprint: 'caller-a', adjacency: adjacency('after'), receivedAt: NOW })

    expect(heard.list({ now: NOW })).toHaveLength(1)
    expect(heard.list({ now: NOW })[0]?.adjacency.self.label).toBe('after')
  })

  it('forgets a caller that is no longer paired', () => {
    const heard = createHostGraphHeardReports({ now: () => NOW })
    heard.record({ callerFingerprint: 'caller-a', adjacency: adjacency('a'), receivedAt: NOW })
    heard.forget('caller-a')

    expect(heard.list({ now: NOW })).toEqual([])
  })
})
