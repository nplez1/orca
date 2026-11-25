import { describe, expect, it } from 'vitest'
import { HOST_GRAPH_MAX_EDGES, HOST_GRAPH_MAX_SSH_KEYS } from '../host-graph/host-graph-contract'
import { HostGraphExchangeParams } from './host-graph-params'

const SELF = {
  version: 1,
  self: { ref: { orcaHostKey: 'studio-key' }, label: 'studio' },
  edges: [
    {
      to: { orcaHostKey: 'vm-key' },
      label: 'vm',
      kind: 'pairing-out' as const,
      liveness: 'connected' as const,
      observedAt: 1
    }
  ],
  revision: 'deadbeef',
  generatedAt: 1
}

describe('host graph exchange params', () => {
  it('accepts the first exchange, which carries no known revision', () => {
    const parsed = HostGraphExchangeParams.parse({ self: SELF })

    expect(parsed.self?.edges).toHaveLength(1)
    expect(parsed).not.toHaveProperty('knownRevision')
  })

  it('accepts a caller that cannot describe itself yet', () => {
    expect(HostGraphExchangeParams.parse({ self: null }).self).toBeNull()
  })

  it('keeps a field a newer sender added rather than rejecting the whole adjacency', () => {
    const parsed = HostGraphExchangeParams.parse({
      self: { ...SELF, edges: [{ ...SELF.edges[0], latencyMs: 12 }] }
    })

    expect(parsed.self?.edges[0].label).toBe('vm')
  })

  it('refuses an edge list that could inflate another host’s fleet count', () => {
    const edges = Array.from({ length: HOST_GRAPH_MAX_EDGES + 1 }, () => SELF.edges[0])

    expect(HostGraphExchangeParams.safeParse({ self: { ...SELF, edges } }).success).toBe(false)
  })

  it('refuses more SSH keys than a machine may claim', () => {
    const sshHostKeys = Array.from(
      { length: HOST_GRAPH_MAX_SSH_KEYS + 1 },
      (_, index) => `k${index}`
    )

    expect(
      HostGraphExchangeParams.safeParse({
        self: { ...SELF, self: { ref: { sshHostKeys }, label: 'studio' } }
      }).success
    ).toBe(false)
  })

  it('refuses an adjacency that names no machine at all', () => {
    expect(
      HostGraphExchangeParams.safeParse({
        self: { ...SELF, self: { ref: {}, label: '' } }
      }).success
    ).toBe(false)
  })
})
