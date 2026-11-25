import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency,
  type HostGraphExchangeResult,
  type HostGraphHeardReport
} from '../../shared/host-graph/host-graph-contract'
import type { PairingOffer } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  refreshHostGraph,
  resetHostGraphDriver,
  type HostGraphDriverDeps,
  type HostGraphPeerEnvironment
} from './host-graph-driver'

const BASE = 1_700_000_000_000

type Send = (
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<HostGraphExchangeResult>>

function adjacency(
  label: string,
  edges: readonly { label: string; orcaHostKey: string }[] = []
): HostGraphAdjacency {
  return {
    version: HOST_GRAPH_PAYLOAD_VERSION,
    self: { ref: { orcaHostKey: `key-${label}` }, label },
    edges: edges.map((edge) => ({
      to: { orcaHostKey: edge.orcaHostKey },
      label: edge.label,
      kind: 'pairing-out' as const,
      liveness: 'connected' as const,
      observedAt: BASE
    })),
    revision: `rev-${label}-${edges.length}`,
    generatedAt: BASE
  }
}

function fullAnswer(
  label: string,
  edges: readonly { label: string; orcaHostKey: string }[] = [],
  heard: readonly HostGraphHeardReport[] = []
): RuntimeRpcResponse<HostGraphExchangeResult> {
  const value = adjacency(label, edges)
  return {
    id: 'rpc-1',
    ok: true,
    result: { adjacency: value, heard: [...heard], revision: `rev-${label}-${value.revision}` },
    _meta: { runtimeId: 'rt' }
  }
}

function refusal(code: string): RuntimeRpcResponse<HostGraphExchangeResult> {
  return { id: 'rpc-1', ok: false, error: { code, message: code } }
}

// Every field the schema requires, and nothing else: the fan-out never reads it in these tests.
const PEER_OFFER: PairingOffer = {
  v: 2,
  endpoint: 'ws://127.0.0.1:1/graph',
  deviceToken: 'device-token',
  publicKeyB64: 'a2V5'
}

function harness(
  peers: readonly HostGraphPeerEnvironment[],
  send: Send,
  options: { heard?: readonly HostGraphHeardReport[]; own?: HostGraphAdjacency } = {}
) {
  const clock = { now: BASE }
  const deps: HostGraphDriverDeps = {
    listEnvironments: async () => peers,
    resolvePairing: async (environmentId) => ({ environmentId, offer: PEER_OFFER }),
    sendRequest: (peer, method, params, timeoutMs) =>
      send(peer.environmentId, method, params, timeoutMs),
    readOwn: async () => options.own ?? adjacency('viewer'),
    readHeard: () => [...(options.heard ?? [])],
    now: () => clock.now
  }
  return { deps, clock }
}

function labels(nodes: readonly { label: string }[]): string[] {
  return nodes.map((node) => node.label)
}

beforeEach(() => {
  resetHostGraphDriver()
})

describe('refreshHostGraph', () => {
  it('keeps a host’s machines when it answers unchanged', async () => {
    let attempt = 0
    const send = vi.fn<Send>(async () => {
      attempt += 1
      return attempt === 1
        ? fullAnswer('Hub', [{ label: 'Studio', orcaHostKey: 'key-studio' }])
        : { id: 'rpc-2', ok: true, result: { unchanged: true }, _meta: { runtimeId: 'rt' } }
    })
    const { deps } = harness([{ id: 'env-a', name: 'Hub' }], send)

    expect(labels((await refreshHostGraph(deps)).fleet.nodes)).toEqual(['Hub', 'Studio'])
    expect(labels((await refreshHostGraph(deps)).fleet.nodes)).toEqual(['Hub', 'Studio'])
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('remembers a host that cannot answer the exchange', async () => {
    const send = vi.fn<Send>(async () => refusal('method_not_found'))
    const { deps, clock } = harness([{ id: 'env-a', name: 'Older Orca' }], send)

    expect((await refreshHostGraph(deps)).failures).toEqual([
      { environmentId: 'env-a', name: 'Older Orca', code: 'capability_unsupported' }
    ])
    clock.now += 60_000
    expect((await refreshHostGraph(deps)).failures[0].code).toBe('capability_unsupported')
    expect(send).toHaveBeenCalledTimes(1)
    clock.now += 10 * 60_000
    await refreshHostGraph(deps)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a host that never answers does not remove another host’s machines', async () => {
    const send = vi.fn<Send>(async (environmentId) => {
      if (environmentId === 'env-dead') {
        throw new Error('socket closed')
      }
      return fullAnswer('Hub', [{ label: 'Studio', orcaHostKey: 'key-studio' }])
    })
    const { deps } = harness(
      [
        { id: 'env-dead', name: 'Dead' },
        { id: 'env-a', name: 'Hub' }
      ],
      send
    )

    const snapshot = await refreshHostGraph(deps)
    expect(labels(snapshot.fleet.nodes)).toEqual(['Hub', 'Studio'])
    expect(snapshot.failures).toEqual([
      { environmentId: 'env-dead', name: 'Dead', code: 'host_unavailable' }
    ])
  })

  it('stops asking once the total deadline is spent', async () => {
    const peers = Array.from({ length: 6 }, (_, index) => ({
      id: `env-${index}`,
      name: `Host ${index}`
    }))
    const send = vi.fn<Send>(async (environmentId) => {
      clock.now += 5_000
      return fullAnswer(environmentId)
    })
    const { deps, clock } = harness(peers, send)

    const snapshot = await refreshHostGraph(deps)
    expect(send).toHaveBeenCalledTimes(4)
    expect(snapshot.failures.map((failure) => failure.code)).toEqual([
      'host_unavailable',
      'host_unavailable'
    ])
  })

  it('shows the machines that called this host, though it asked nobody', async () => {
    // The VM in the documented topology: nothing to call, one machine that calls it.
    const studioReport: HostGraphHeardReport = {
      adjacency: adjacency('Studio', [
        { label: 'Laptop', orcaHostKey: 'key-Laptop' },
        { label: 'Windows', orcaHostKey: 'key-Windows' },
        { label: 'VM', orcaHostKey: 'key-VM' }
      ]),
      reportedBy: 'fp-studio',
      receivedAt: BASE
    }
    const send = vi.fn<Send>(async () => {
      throw new Error('this host has nobody to ask')
    })
    const { deps } = harness([], send, {
      heard: [studioReport],
      own: adjacency('VM')
    })

    const snapshot = await refreshHostGraph(deps)

    expect(send).not.toHaveBeenCalled()
    // Distance order: the machine that called this one, then the machines it reported.
    expect(labels(snapshot.fleet.nodes)).toEqual(['Studio', 'Laptop', 'Windows'])
  })

  it('counts the same fleet from the hub as from the leaf that asked it', async () => {
    const laptopReport: HostGraphHeardReport = {
      adjacency: adjacency('Laptop'),
      reportedBy: 'fp-laptop',
      receivedAt: BASE
    }
    const send = vi.fn<Send>(async (environmentId) => {
      return environmentId === 'env-vm' ? fullAnswer('VM') : fullAnswer('Windows')
    })
    const { deps } = harness(
      [
        { id: 'env-vm', name: 'VM' },
        { id: 'env-windows', name: 'Windows' }
      ],
      send,
      {
        heard: [laptopReport],
        // The Studio's own pairings, which is also what it hands to the laptop that asks it.
        own: adjacency('Studio', [
          { label: 'VM', orcaHostKey: 'key-VM' },
          { label: 'Windows', orcaHostKey: 'key-Windows' }
        ])
      }
    )

    const snapshot = await refreshHostGraph(deps)

    expect(labels(snapshot.fleet.nodes)).toEqual(['Laptop', 'VM', 'Windows'])
  })
})
