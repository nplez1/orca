import { describe, expect, it } from 'vitest'
import { HOST_GRAPH_MAX_EDGES } from '../../shared/host-graph/host-graph-contract'
import { hostGraphRevision } from '../../shared/host-graph/host-graph-compose'
import {
  buildOwnAdjacency,
  type HostGraphOwnEdgeEnvironment,
  type HostGraphOwnEdgeSources
} from './host-graph-own-edges'

const NOW = 1_700_000_000_000
const ORCA_HOST_KEY = '3b2dae6bfba03d78d8d79af67357e883'

function environment(
  overrides: Partial<HostGraphOwnEdgeEnvironment> = {}
): HostGraphOwnEdgeEnvironment {
  return {
    id: 'env-1',
    name: 'Studio',
    preferredEndpointId: 'endpoint-1',
    endpoints: [
      {
        id: 'endpoint-1',
        kind: 'websocket',
        label: 'LAN',
        endpoint: 'wss://hub.tailnet.example:6768/',
        deviceToken: 'device-token-secret',
        publicKeyB64: 'pairing-public-key'
      }
    ],
    ...overrides
  }
}

function sshAccess(sshTargetId: string): HostGraphOwnEdgeEnvironment['sshAccess'] {
  return {
    sshTargetId,
    sshTargetGeneration: 1,
    localPort: 6768,
    remotePort: 6768,
    endpointId: 'endpoint-1',
    previousPreferredEndpointId: 'endpoint-2'
  }
}

function sources(overrides: Partial<HostGraphOwnEdgeSources> = {}): HostGraphOwnEdgeSources {
  return {
    now: NOW,
    self: { label: 'workstation' },
    environments: [],
    sshTargets: [],
    trustedHostKeys: [],
    connectedSshTargetIds: [],
    ...overrides
  }
}

describe('buildOwnAdjacency', () => {
  it('discloses keys and never the pairing that reaches a machine', () => {
    const adjacency = buildOwnAdjacency(
      sources({
        environments: [environment({ sshAccess: sshAccess('ssh-1') })],
        sshTargets: [{ id: 'ssh-1', host: '10.0.0.5', port: 22, label: 'Studio box' }],
        trustedHostKeys: [{ host: '10.0.0.5', port: 22, fingerprint: 'SHA256:hubfingerprint' }]
      })
    )

    const serialized = JSON.stringify(adjacency)
    expect(serialized).not.toContain('device-token-secret')
    expect(serialized).not.toContain('pairing-public-key')
    expect(serialized).not.toContain('hub.tailnet.example')
    expect(serialized).not.toContain('ssh-1')
    expect(serialized).not.toContain('env-1')
    expect(adjacency.edges).toEqual([
      {
        to: { orcaHostKey: ORCA_HOST_KEY, sshHostKeys: ['SHA256:hubfingerprint'] },
        label: 'Studio',
        kind: 'pairing-out',
        liveness: 'idle',
        observedAt: NOW
      },
      {
        to: { sshHostKeys: ['SHA256:hubfingerprint'] },
        label: 'Studio box',
        kind: 'ssh',
        liveness: 'idle',
        observedAt: NOW
      }
    ])
  })

  it('leaves out a recipe VM, which is a scratch workspace rather than a machine', () => {
    const adjacency = buildOwnAdjacency(
      sources({ environments: [environment({ source: 'ephemeral-vm' })] })
    )

    expect(adjacency.edges).toEqual([])
  })

  it('leaves out an SSH target the host-key store has never accepted', () => {
    const unpaired = buildOwnAdjacency(
      sources({ sshTargets: [{ id: 'ssh-2', host: '10.0.0.9', port: 22, label: 'Box' }] })
    )
    expect(unpaired.edges).toEqual([])

    const paired = buildOwnAdjacency(
      sources({
        sshTargets: [{ id: 'ssh-2', host: '10.0.0.9', port: 2222, label: 'Box' }],
        trustedHostKeys: [
          { host: '10.0.0.9', port: 22, fingerprint: 'SHA256:other-port' },
          { host: '10.0.0.9', port: 2222, fingerprint: 'SHA256:the-port' }
        ]
      })
    )
    expect(paired.edges).toEqual([
      {
        to: { sshHostKeys: ['SHA256:the-port'] },
        label: 'Box',
        kind: 'ssh',
        liveness: 'idle',
        observedAt: NOW
      }
    ])
  })

  it('names the SSH tunnel a paired environment rides', () => {
    const adjacency = buildOwnAdjacency(
      sources({
        environments: [environment({ sshAccess: sshAccess('ssh-1') })],
        sshTargets: [{ id: 'ssh-1', host: '10.0.0.5', port: 22 }],
        trustedHostKeys: [{ host: '10.0.0.5', port: 22, fingerprint: 'SHA256:hubfingerprint' }]
      })
    )

    expect(adjacency.edges[0]?.to).toEqual({
      orcaHostKey: ORCA_HOST_KEY,
      sshHostKeys: ['SHA256:hubfingerprint']
    })
    expect(adjacency.edges[0]?.kind).toBe('pairing-out')
  })

  it('reports a live connection for the target id that holds one', () => {
    const adjacency = buildOwnAdjacency(
      sources({
        sshTargets: [{ id: 'ssh-1', host: '10.0.0.5', port: 22, label: 'Box' }],
        trustedHostKeys: [{ host: '10.0.0.5', port: 22, fingerprint: 'SHA256:hubfingerprint' }],
        connectedSshTargetIds: ['ssh-1']
      })
    )

    expect(adjacency.edges[0]?.liveness).toBe('connected')
  })

  it('caps the edges and stamps the revision of what it actually sent', () => {
    const environments = Array.from({ length: HOST_GRAPH_MAX_EDGES + 5 }, (_, index) =>
      environment({ id: `env-${index}`, name: `Host ${index}` })
    )
    const adjacency = buildOwnAdjacency(sources({ environments }))

    expect(adjacency.edges).toHaveLength(HOST_GRAPH_MAX_EDGES)
    expect(adjacency.edges[0]?.label).toBe('Host 0')
    expect(adjacency.revision).toBe(hostGraphRevision(adjacency))
    expect(adjacency.version).toBe(1)
    expect(adjacency.generatedAt).toBe(NOW)
    expect(adjacency.self).toEqual({ ref: {}, label: 'workstation' })
  })

  it('truncates a label longer than the contract allows', () => {
    const adjacency = buildOwnAdjacency(
      sources({ environments: [environment({ name: 'x'.repeat(400) })] })
    )

    expect(adjacency.edges[0]?.label).toHaveLength(256)
  })
})
