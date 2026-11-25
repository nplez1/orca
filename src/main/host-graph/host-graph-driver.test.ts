import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency,
  type HostGraphExchangeResult
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
  edges: readonly { label: string; orcaHostKey: string }[] = []
): RuntimeRpcResponse<HostGraphExchangeResult> {
  return {
    id: 'rpc-1',
    ok: true,
    result: { adjacency: adjacency(label, edges), heard: [] },
    _meta: { runtimeId: 'rt' }
  }
}

function refusal(code: string): RuntimeRpcResponse<HostGraphExchangeResult> {
  return { id: 'rpc-1', ok: false, error: { code, message: code } }
}

function harness(peers: readonly HostGraphPeerEnvironment[], send: Send) {
  const clock = { now: BASE }
  const deps: HostGraphDriverDeps = {
    listEnvironments: async () => peers,
    // The fake pairing carries only which environment it came from; sendRequest is injected too.
    resolvePairing: async (environmentId) => ({ environmentId }) as unknown as PairingOffer,
    sendRequest: (pairing, method, params, timeoutMs) =>
      send(
        (pairing as unknown as { environmentId: string }).environmentId,
        method,
        params,
        timeoutMs
      ),
    readOwn: async () => adjacency('viewer'),
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
})
