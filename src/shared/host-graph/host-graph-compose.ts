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
  /** A machine this client asked, or one that asked this client. */
  adjacency: HostGraphAdjacency
  /** Machines that reported themselves to the `adjacency`'s machine. Never re-nested. */
  heard: readonly HostGraphHeardReport[]
  /** When this fact was last confirmed: the answer's arrival, or the report's own arrival there. */
  receivedAt: number
  /**
   * Hops between this client and the reporting machine. 1 for a direct pairing in either direction,
   * which is the only value the driver produces. It exists so a report reached through another host
   * is capped out rather than silently counted at a depth it was never confirmed at.
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
    // Why empty: the reporter itself is a machine this client is paired with, in whichever direction.
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
    // Hearsay is one hop beyond the reporter and is never walked further, which is what bounds the
    // payload's depth. Its own timestamp travels with it, so an ageing report ages here too.
    for (const report of answer.heard) {
      observations.push({
        ref: report.adjacency.self.ref,
        label: report.adjacency.self.label,
        distance: depth + 1,
        via,
        liveness: 'connected',
        lastConfirmedAt: report.receivedAt
      })
      for (const edge of report.adjacency.edges) {
        observations.push({
          ref: edge.to,
          label: edge.label,
          distance: depth + 1,
          via,
          liveness: edge.liveness,
          lastConfirmedAt: report.receivedAt
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
  const selfRefs = input.own ? [input.viewer, input.own.self.ref] : [input.viewer]
  const nodes: HostGraphFleetNode[] = merged.groups.filter(
    (group) => !selfRefs.some((ref) => isSelfGroup(group.ref, ref))
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
 * Whether a composed entry is this client's own machine.
 *
 * Why an SSH-key match cannot identify us once the entry carries a pairing key: every peer is told our
 * SSH keys, so otherwise one peer could claim any machine's pairing key alongside our SSH key and have
 * that machine dropped from our own list. VM images cloned from one template also share host keys.
 */
function isSelfGroup(ref: HostGraphMachineRef, self: HostGraphMachineRef): boolean {
  if (ref.orcaHostKey || self.orcaHostKey) {
    return ref.orcaHostKey !== undefined && ref.orcaHostKey === self.orcaHostKey
  }
  const selfKeys = new Set(self.sshHostKeys ?? [])
  return (ref.sshHostKeys ?? []).some((key) => selfKeys.has(key))
}

/**
 * Merge observations that describe one machine.
 *
 * Why an `orcaHostKey` match is trusted but an SSH-key match is conditional: two paths to one machine
 * carry that machine's own pairing key, so it is evidence the machine itself supplied. An SSH host key
 * is self-reported too, so it may complete an SSH-only entry — but never join two components that each
 * presented a *different* pairing key, because then a lying peer could hide another host from the count
 * by claiming its SSH key. The check is made between components at union time, so a chain that bridges
 * two pairing keys through two different SSH keys is refused as a whole rather than one link at a time.
 */
function mergeByMachine(observations: readonly Observation[]): {
  groups: HostGraphFleetNode[]
  conflicts: number
} {
  const parent = observations.map((_, index) => index)
  const rootOf = (index: number): number => {
    let root = index
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]]
      root = parent[root]
    }
    return root
  }
  const orcaKeysByRoot = new Map<number, Set<string>>()
  observations.forEach((observation, index) => {
    const key = observation.ref.orcaHostKey
    orcaKeysByRoot.set(index, key ? new Set([key]) : new Set())
  })
  const union = (left: number, right: number): void => {
    const leftRoot = rootOf(left)
    const rightRoot = rootOf(right)
    if (leftRoot === rightRoot) {
      return
    }
    parent[rightRoot] = leftRoot
    const merged = orcaKeysByRoot.get(leftRoot) ?? new Set<string>()
    for (const key of orcaKeysByRoot.get(rightRoot) ?? []) {
      merged.add(key)
    }
    orcaKeysByRoot.set(leftRoot, merged)
    orcaKeysByRoot.delete(rightRoot)
  }
  const pairingKeysOf = (roots: readonly number[]): Set<string> => {
    const keys = new Set<string>()
    for (const root of roots) {
      for (const key of orcaKeysByRoot.get(rootOf(root)) ?? []) {
        keys.add(key)
      }
    }
    return keys
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
    if (!alias.startsWith('orca\u0000')) {
      continue
    }
    for (const member of members.slice(1)) {
      union(members[0], member)
    }
  }

  let conflicts = 0
  for (const [alias, members] of byAlias) {
    if (!alias.startsWith('ssh\u0000')) {
      continue
    }
    const roots = [...new Set(members.map((member) => rootOf(member)))]
    if (roots.length < 2) {
      continue
    }
    if (pairingKeysOf(roots).size > 1) {
      conflicts += 1
      continue
    }
    for (const root of roots.slice(1)) {
      union(roots[0], root)
    }
  }

  const byRoot = new Map<number, Observation[]>()
  observations.forEach((observation, index) => {
    const root = rootOf(index)
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

/**
 * The revision of a whole answer, hearsay included.
 *
 * Why the adjacency's own revision is not enough: a host that is only ever *called* changes what it
 * would tell the next caller whenever a new caller appears, while its own pairings have not moved. An
 * `unchanged` reply keyed on the adjacency alone would then keep a new machine invisible to everyone
 * else for as long as the caller asked. Report arrival times are excluded for the same reason
 * `observedAt` is: membership is what matters, not when it was last re-sent.
 */
export function hostGraphAnswerRevision(
  own: Pick<HostGraphAdjacency, 'revision'>,
  heard: readonly HostGraphHeardReport[]
): string {
  const parts = [own.revision]
  for (const report of heard) {
    parts.push(`${report.reportedBy}\u001f${report.adjacency.revision}`)
  }
  return fnv1a(parts.sort().join('\u0000'))
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
