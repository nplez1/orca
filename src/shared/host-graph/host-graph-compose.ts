import {
  HOST_GRAPH_HOP_CAP,
  HOST_GRAPH_MAX_NODES,
  HOST_GRAPH_NODE_TTL_MS,
  type HostGraphAdjacency,
  type HostGraphHeardReport,
  type HostGraphMachineRef
} from './host-graph-contract'

/**
 * Composing a fleet from what this client can see.
 *
 * Why this is pure: the inputs are other machines' claims, so the rules that decide what they are
 * allowed to make the count say — a hop cap, a refused merge, a stale node — must be testable without
 * a socket. Everything here is a function of its arguments.
 */

export type HostGraphAnswer = {
  /** The paired host's own adjacency, as it answered. */
  adjacency: HostGraphAdjacency
  /** Machines that called the paired host, as it reported them. Never re-nested. */
  heard: readonly HostGraphHeardReport[]
  receivedAt: number
  /**
   * Hops between this client and the reporter. 1 for a direct pairing, which is the only case the
   * driver produces today. It exists so a report reached through another host is capped out rather
   * than silently counted at a depth it was never confirmed at.
   */
  depth?: number
}

export type HostGraphComposeInput = {
  /** This client's own machine, excluded from the result: the ask is "all the OTHER hosts". */
  viewer: HostGraphMachineRef
  /** This client's own adjacency, when it has one. Its edges are distance 1. */
  own: HostGraphAdjacency | null
  answers: readonly HostGraphAnswer[]
  now: number
}

export type HostGraphFleetNode = {
  ref: HostGraphMachineRef
  label: string
  /** 1 = this client is paired with it; 2 = reported by a machine this client is paired with. */
  distance: number
  /** Labels of the machines the fact travelled through, nearest first. Empty for a direct pairing. */
  via: string[]
  liveness: 'connected' | 'idle'
  /** The newest moment any observation of this machine was confirmed. Drives expiry. */
  lastConfirmedAt: number
}

export type HostGraphFleet = {
  nodes: HostGraphFleetNode[]
  /** Merges refused because two machines claimed one SSH host key. Shown, never silently dropped. */
  aliasConflicts: number
  /** The node cap was reached, so this list is not necessarily the whole fleet. */
  truncated: boolean
}

type Observation = {
  ref: HostGraphMachineRef
  label: string
  distance: number
  via: string[]
  liveness: 'connected' | 'idle'
  lastConfirmedAt: number
}

export function composeHostGraph(input: HostGraphComposeInput): HostGraphFleet {
  const observations: Observation[] = []

  for (const edge of input.own?.edges ?? []) {
    observations.push({
      ref: edge.to,
      label: edge.label,
      distance: 1,
      via: [],
      liveness: edge.liveness,
      lastConfirmedAt: input.now
    })
  }

  for (const answer of input.answers) {
    const reporter = answer.adjacency
    const depth = answer.depth ?? 1
    const via = [reporter.self.label]
    observations.push({
      ref: reporter.self.ref,
      label: reporter.self.label,
      distance: depth,
      via: [],
      liveness: 'connected',
      lastConfirmedAt: answer.receivedAt
    })
    for (const edge of reporter.edges) {
      observations.push({
        ref: edge.to,
        label: edge.label,
        distance: depth + 1,
        via,
        liveness: edge.liveness,
        lastConfirmedAt: answer.receivedAt
      })
    }
    // Hearsay keeps its distance at the reporter's: we do not walk a peer's neighbours' edges, which
    // is what bounds the payload's depth without a per-hop decrement we would get wrong.
    for (const report of answer.heard) {
      observations.push({
        ref: report.adjacency.self.ref,
        label: report.adjacency.self.label,
        distance: depth + 1,
        via,
        liveness: 'connected',
        lastConfirmedAt: answer.receivedAt
      })
      for (const edge of report.adjacency.edges) {
        observations.push({
          ref: edge.to,
          label: edge.label,
          distance: depth + 1,
          via,
          liveness: edge.liveness,
          lastConfirmedAt: answer.receivedAt
        })
      }
    }
  }

  const live = observations.filter(
    (observation) =>
      observation.distance <= HOST_GRAPH_HOP_CAP &&
      input.now - observation.lastConfirmedAt <= HOST_GRAPH_NODE_TTL_MS
  )

  const merged = mergeByMachine(live)
  const nodes: HostGraphFleetNode[] = merged.groups.filter(
    (group) => !sharesMachine(group.ref, input.viewer)
  )

  nodes.sort(
    (left, right) => left.distance - right.distance || left.label.localeCompare(right.label)
  )
  const truncated = nodes.length > HOST_GRAPH_MAX_NODES
  return {
    nodes: truncated ? nodes.slice(0, HOST_GRAPH_MAX_NODES) : nodes,
    aliasConflicts: merged.conflicts,
    truncated
  }
}

/**
 * Merge observations that describe one machine.
 *
 * Why an `orcaHostKey` match is trusted but an SSH-key match is conditional: two paths to one machine
 * carry that machine's own pairing key, so it is evidence the machine itself supplied. An SSH host key
 * is self-reported too, so it may complete an SSH-only entry — but never join two machines that each
 * presented a *different* pairing key, because then a lying peer could hide another host from the
 * count by claiming its SSH key.
 */
function mergeByMachine(observations: readonly Observation[]): {
  groups: HostGraphFleetNode[]
  conflicts: number
} {
  const parent = observations.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]]
      root = parent[root]
    }
    return root
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot
    }
  }

  const byAlias = new Map<string, number[]>()
  observations.forEach((observation, index) => {
    for (const alias of aliasesOf(observation.ref)) {
      const existing = byAlias.get(alias)
      if (existing) {
        existing.push(index)
      } else {
        byAlias.set(alias, [index])
      }
    }
  })

  for (const [alias, members] of byAlias) {
    if (alias.startsWith('orca\u0000')) {
      for (const member of members.slice(1)) {
        union(members[0], member)
      }
    }
  }

  let conflicts = 0
  for (const [alias, members] of byAlias) {
    if (!alias.startsWith('ssh\u0000')) {
      continue
    }
    const orcaKeys = new Set<string>()
    for (const member of members) {
      const key = observations[member].ref.orcaHostKey
      if (key) {
        orcaKeys.add(key)
      }
    }
    if (orcaKeys.size > 1) {
      conflicts += 1
      continue
    }
    for (const member of members.slice(1)) {
      union(members[0], member)
    }
  }

  const byRoot = new Map<number, Observation[]>()
  observations.forEach((observation, index) => {
    const root = find(index)
    const existing = byRoot.get(root)
    if (existing) {
      existing.push(observation)
    } else {
      byRoot.set(root, [observation])
    }
  })

  const groups: HostGraphFleetNode[] = []
  for (const group of byRoot.values()) {
    groups.push(collapseGroup(group))
  }
  return { groups, conflicts }
}

function collapseGroup(group: readonly Observation[]): HostGraphFleetNode {
  const orcaHostKey = group.find((observation) => observation.ref.orcaHostKey)?.ref.orcaHostKey
  const sshHostKeys = [
    ...new Set(group.flatMap((observation) => observation.ref.sshHostKeys ?? []))
  ].sort()
  const nearest = group.reduce((best, observation) =>
    isBetterLabelSource(observation, best) ? observation : best
  )
  return {
    ref: {
      ...(orcaHostKey ? { orcaHostKey } : {}),
      ...(sshHostKeys.length > 0 ? { sshHostKeys } : {})
    },
    label: nearest.label,
    distance: nearest.distance,
    via: nearest.via,
    liveness: group.some((observation) => observation.liveness === 'connected')
      ? 'connected'
      : 'idle',
    lastConfirmedAt: Math.max(...group.map((observation) => observation.lastConfirmedAt))
  }
}

/** Nearest wins; on a tie the entry that named its own pairing key is the machine's own answer. */
function isBetterLabelSource(candidate: Observation, best: Observation): boolean {
  if (candidate.distance !== best.distance) {
    return candidate.distance < best.distance
  }
  if (Boolean(candidate.ref.orcaHostKey) !== Boolean(best.ref.orcaHostKey)) {
    return Boolean(candidate.ref.orcaHostKey)
  }
  return candidate.lastConfirmedAt > best.lastConfirmedAt
}

function aliasesOf(ref: HostGraphMachineRef): string[] {
  const aliases: string[] = []
  if (ref.orcaHostKey) {
    aliases.push(`orca\u0000${ref.orcaHostKey}`)
  }
  for (const key of ref.sshHostKeys ?? []) {
    aliases.push(`ssh\u0000${key}`)
  }
  return aliases
}

function sharesMachine(left: HostGraphMachineRef, right: HostGraphMachineRef): boolean {
  if (left.orcaHostKey && right.orcaHostKey && left.orcaHostKey === right.orcaHostKey) {
    return true
  }
  const rightKeys = new Set(right.sshHostKeys ?? [])
  return (left.sshHostKeys ?? []).some((key) => rightKeys.has(key))
}

/**
 * A digest of what a peer would be told, for the `knownRevision` short-circuit.
 *
 * Why `observedAt` and `generatedAt` are excluded: they change on every call, so including them would
 * make every answer "changed" and defeat the one-word reply. Liveness stays in, because that is what a
 * peer actually acts on.
 */
export function hostGraphRevision(adjacency: Pick<HostGraphAdjacency, 'self' | 'edges'>): string {
  const parts = [adjacency.self.label, ...aliasesOf(adjacency.self.ref).sort()]
  for (const edge of adjacency.edges) {
    parts.push(`\u001f${edge.kind}\u001f${edge.liveness}\u001f${edge.label}`)
    parts.push(...aliasesOf(edge.to).sort())
  }
  return fnv1a(parts.join('\u0000'))
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
