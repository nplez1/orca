import { describe, expect, it } from 'vitest'
import {
  HOST_GRAPH_MAX_NODES,
  HOST_GRAPH_NODE_TTL_MS,
  type HostGraphAdjacency,
  type HostGraphEdge,
  type HostGraphMachineRef
} from './host-graph-contract'
import {
  composeHostGraph,
  hostGraphRevision,
  type HostGraphAnswer,
  type HostGraphComposeInput
} from './host-graph-compose'

const NOW = 1_700_000_000_000

function machine(orcaHostKey?: string, sshHostKeys?: string[]): HostGraphMachineRef {
  return {
    ...(orcaHostKey ? { orcaHostKey } : {}),
    ...(sshHostKeys ? { sshHostKeys } : {})
  }
}

function edge(
  to: HostGraphMachineRef,
  label: string,
  liveness: HostGraphEdge['liveness'] = 'connected',
  kind: HostGraphEdge['kind'] = 'pairing-out'
): HostGraphEdge {
  return { to, label, kind, liveness, observedAt: NOW }
}

function adjacency(
  label: string,
  self: HostGraphMachineRef,
  edges: HostGraphEdge[] = []
): HostGraphAdjacency {
  return {
    version: 1,
    self: { ref: self, label },
    edges,
    revision: hostGraphRevision({ self: { ref: self, label }, edges }),
    generatedAt: NOW
  }
}

function answer(
  adjacencyValue: HostGraphAdjacency,
  heard: HostGraphAnswer['heard'] = []
): HostGraphAnswer {
  return { adjacency: adjacencyValue, heard, receivedAt: NOW }
}

const VIEWER = machine('viewer-key')

function compose(input: Partial<HostGraphComposeInput>): ReturnType<typeof composeHostGraph> {
  return composeHostGraph({
    viewer: VIEWER,
    own: null,
    answers: [],
    now: NOW,
    ...input
  })
}

describe('composing the fleet a client can see', () => {
  it('never lists the viewer’s own machine, however it arrives', () => {
    const own = adjacency('laptop', VIEWER, [edge(machine('studio-key'), 'studio')])
    const studio = adjacency('studio', machine('studio-key'), [
      edge(VIEWER, 'laptop'),
      edge(machine('vm-key'), 'vm')
    ])

    const fleet = compose({
      own,
      answers: [
        answer(studio, [
          { adjacency: adjacency('laptop', VIEWER), reportedBy: 'fp', receivedAt: NOW }
        ])
      ]
    })

    expect(fleet.nodes.map((node) => node.label)).toEqual(['studio', 'vm'])
  })

  it('collapses two paths to one machine into a single node, keeping the nearest', () => {
    const own = adjacency('laptop', VIEWER, [edge(machine('vm-key'), 'vm')])
    const studio = adjacency('studio', machine('studio-key'), [edge(machine('vm-key'), 'vm')])

    const fleet = compose({ own, answers: [answer(studio)] })

    expect(fleet.nodes).toHaveLength(2)
    const vm = fleet.nodes.find((node) => node.label === 'vm')
    expect(vm).toMatchObject({ distance: 1, via: [] })
  })

  it('labels a machine it only learns from a peer with the peer it came through', () => {
    const studio = adjacency('studio', machine('studio-key'), [edge(machine('vm-key'), 'vm')])

    const fleet = compose({ answers: [answer(studio)] })

    expect(fleet.nodes.map((node) => [node.label, node.distance, node.via])).toEqual([
      ['studio', 1, []],
      ['vm', 2, ['studio']]
    ])
  })

  it('counts a machine a peer heard from, so a leaf and its hub agree on the fleet', () => {
    const studio = adjacency('studio', machine('studio-key'), [edge(machine('vm-key'), 'vm')])
    const laptopReport = adjacency('another-laptop', machine('laptop-2-key'), [
      edge(machine('windows-key'), 'windows')
    ])

    const fleet = compose({
      answers: [answer(studio, [{ adjacency: laptopReport, reportedBy: 'fp', receivedAt: NOW }])]
    })

    expect(fleet.nodes.map((node) => node.label).sort()).toEqual([
      'another-laptop',
      'studio',
      'vm',
      'windows'
    ])
  })

  it('takes the node a distant report names but not that report’s neighbours', () => {
    const distant = adjacency('far', machine('far-key'), [edge(machine('farther-key'), 'farther')])
    const distantAnswer = { ...answer(distant), depth: 2 }

    const fleet = compose({ answers: [distantAnswer] })

    expect(fleet.nodes.map((node) => node.label)).toEqual(['far'])
  })

  it('refuses to merge two machines that each presented a different pairing key', () => {
    const studio = adjacency('studio', machine('studio-key'), [
      edge(machine('vm-key', ['SHA256:shared']), 'vm')
    ])
    const side = adjacency('side', machine('side-key'), [
      edge(machine('other-key', ['SHA256:shared']), 'other')
    ])

    const fleet = compose({ answers: [answer(studio), answer(side)] })

    expect(fleet.aliasConflicts).toBe(1)
    expect(fleet.nodes.map((node) => node.label).sort()).toEqual(['other', 'side', 'studio', 'vm'])
  })

  it('completes an SSH-only entry with the host key the paired machine also presents', () => {
    const own = adjacency('laptop', VIEWER, [
      edge(machine(undefined, ['SHA256:shared']), 'that box')
    ])
    const studio = adjacency('studio', machine('studio-key'), [
      edge(machine('vm-key', ['SHA256:shared']), 'vm')
    ])

    const fleet = compose({ own, answers: [answer(studio)] })

    expect(fleet.aliasConflicts).toBe(0)
    const merged = fleet.nodes.filter(
      (node) => node.ref.orcaHostKey === 'vm-key' || node.label === 'that box'
    )
    expect(merged).toHaveLength(1)
    // One node, addressed by the machine's own pairing key, labelled by the name this client's
    // nearer SSH target gives it.
    expect(merged[0]).toMatchObject({
      ref: { orcaHostKey: 'vm-key' },
      label: 'that box',
      distance: 1
    })
  })

  it('drops a machine that has not been confirmed inside the window', () => {
    const studio = adjacency('studio', machine('studio-key'), [edge(machine('vm-key'), 'vm')])

    const fleet = compose({
      answers: [{ ...answer(studio), receivedAt: NOW - HOST_GRAPH_NODE_TTL_MS - 1 }]
    })

    expect(fleet.nodes).toHaveLength(0)
  })

  it('counts a machine as connected when any path to it is live', () => {
    const own = adjacency('laptop', VIEWER, [edge(machine('vm-key'), 'vm', 'idle')])
    const studio = adjacency('studio', machine('studio-key'), [
      edge(machine('vm-key'), 'vm', 'connected')
    ])

    const fleet = compose({ own, answers: [answer(studio)] })

    expect(fleet.nodes.find((node) => node.label === 'vm')?.liveness).toBe('connected')
  })

  it('truncates at the node cap and says the list is not the whole fleet', () => {
    const edges = Array.from({ length: HOST_GRAPH_MAX_NODES + 20 }, (_, index) =>
      edge(machine(`key-${index}`), `host-${String(index).padStart(3, '0')}`)
    )

    const fleet = compose({ own: adjacency('laptop', VIEWER, edges) })

    expect(fleet.nodes).toHaveLength(HOST_GRAPH_MAX_NODES)
    expect(fleet.truncated).toBe(true)
  })
})

describe('the adjacency revision', () => {
  const self = { ref: machine('studio-key'), label: 'studio' }

  it('does not move when only time passes', () => {
    const first = hostGraphRevision({ self, edges: [edge(machine('vm-key'), 'vm')] })
    const second = hostGraphRevision({
      self,
      edges: [{ ...edge(machine('vm-key'), 'vm'), observedAt: NOW + 60_000 }]
    })

    expect(second).toBe(first)
  })

  it('moves when a machine’s liveness does', () => {
    const live = hostGraphRevision({ self, edges: [edge(machine('vm-key'), 'vm', 'connected')] })
    const idle = hostGraphRevision({ self, edges: [edge(machine('vm-key'), 'vm', 'idle')] })

    expect(idle).not.toBe(live)
  })

  it('moves when the set of machines changes', () => {
    const one = hostGraphRevision({ self, edges: [edge(machine('vm-key'), 'vm')] })
    const two = hostGraphRevision({
      self,
      edges: [edge(machine('vm-key'), 'vm'), edge(machine('win-key'), 'windows')]
    })

    expect(two).not.toBe(one)
  })
})
