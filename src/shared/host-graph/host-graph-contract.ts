/**
 * The wire contract for shared host discovery.
 *
 * Why a symmetric exchange rather than a read: in this fork's topology a leaf (a laptop) holds no
 * outbound pairing to the machines behind its hub, so it cannot call anyone and a pull-only design
 * would leave it showing zero hosts forever. Every caller therefore sends its own adjacency and gets
 * back the callee's own adjacency plus the reports the callee has heard from its callers. Hearsay is
 * labelled as hearsay, never re-nested, so depth stays bounded by the payload's shape.
 *
 * Why nothing is signed: host keys here are X25519 and cannot sign, and the Ed25519 keys we hold are
 * per-client credentials rather than host identity. A second hop could not verify a signature anyway —
 * it only learns C's key *from* B, so it has no independent anchor. Attribution comes from the E2EE
 * transport and `authenticatedCallerFingerprint` instead, and a relayed fact is attributed to the
 * reporter it came from. See `local/design/host-graph.md`.
 */

export const HOST_GRAPH_RUNTIME_CAPABILITY = 'host.graph.adjacency.v1' as const

export const HOST_GRAPH_EXCHANGE_METHOD = 'hostGraph.exchange'

export const HOST_GRAPH_PAYLOAD_VERSION = 1

/**
 * Graph distance a composed node may sit at.
 *
 * Why 2: a host answers with its own pairings plus the machines that reported themselves to it, and a
 * client composes both, so any fleet whose members reach the hub in either direction is seen whole. A
 * chain in which every host only ever calls outward is not: the last machine there is two hops from the
 * host that knows it, and a client three hops away sees neither. Anything deeper would be a report of a
 * report, which the payload shape does not carry.
 */
export const HOST_GRAPH_HOP_CAP = 2

/** Per-report bounds. A reporter cannot inflate its way past these into another host's count. */
export const HOST_GRAPH_MAX_EDGES = 64
export const HOST_GRAPH_MAX_SSH_KEYS = 8
export const HOST_GRAPH_MAX_HEARD = 16
export const HOST_GRAPH_MAX_LABEL_CHARS = 256
export const HOST_GRAPH_MAX_ID_CHARS = 128

/** Composed-fleet bounds, separate from the per-report ones: many reports still make one list. */
export const HOST_GRAPH_MAX_NODES = 256
export const HOST_GRAPH_MAX_REPORT_FILE_BYTES = 256 * 1024

/**
 * How long a composed node survives without being reconfirmed.
 *
 * Why three refresh periods: one dropped exchange must not shrink the list, and a host that has gone
 * away must not be listed as present indefinitely.
 */
export const HOST_GRAPH_NODE_TTL_MS = 5 * 60_000

/**
 * How a machine identifies itself, without disclosing how to reach it.
 *
 * Why these two and not an id: nothing in the execution-host id space proves two rows are one box
 * (`ssh:` and `runtime:` name per-install records), and a route fingerprint distinguishes paths by
 * design. These are keys the machine itself holds, so they are comparable across installs.
 */
export type HostGraphMachineRef = {
  /** `sha256(hostPublicKeyB64)[:32]`, the digest `publicRuntimeEnvironmentWithHostKey` publishes. */
  orcaHostKey?: string
  /** SSH host-key fingerprints in `ssh-host-key-store` form; the only key a non-orcad host has. */
  sshHostKeys?: string[]
}

/**
 * `pairing-out` is a pairing this machine initiates, `pairing-in` a device paired *to* it, `ssh` an
 * SSH target. The kind is disclosure to the fleet and is shown as such.
 */
export type HostGraphEdgeKind = 'pairing-out' | 'pairing-in' | 'ssh'

export type HostGraphEdge = {
  to: HostGraphMachineRef
  label: string
  kind: HostGraphEdgeKind
  liveness: 'connected' | 'idle'
  /** When this machine last saw the edge in that state, so a stale claim is readable as stale. */
  observedAt: number
}

/** One machine's own view: itself and the edges it owns. Deliberately free of endpoints and tokens. */
export type HostGraphAdjacency = {
  version: typeof HOST_GRAPH_PAYLOAD_VERSION
  self: { ref: HostGraphMachineRef; label: string }
  edges: HostGraphEdge[]
  /** Opaque to peers; changes only when `self` or `edges` does, so an unchanged answer is one word. */
  revision: string
  generatedAt: number
}

export type HostGraphExchangeParams = {
  /** The caller's own adjacency; null when it cannot describe itself yet. */
  self: HostGraphAdjacency | null
  /** The callee revision the caller already holds, so an unchanged answer costs no payload. */
  knownRevision?: string
}

export type HostGraphHeardReport = {
  adjacency: HostGraphAdjacency
  /** `authenticatedCallerFingerprint` of the reporter. The only attribution a hop can offer. */
  reportedBy: string
  receivedAt: number
}

export type HostGraphExchangeResult =
  | { unchanged: true }
  /**
   * `revision` covers the adjacency *and* the hearsay in this answer, so a caller can send it back as
   * `knownRevision`. The adjacency's own revision would not notice a new caller appearing here.
   */
  | { adjacency: HostGraphAdjacency; heard: HostGraphHeardReport[]; revision: string }

/** The alias a node is addressed by during composition. */
export type HostGraphAlias = { kind: 'orca'; key: string } | { kind: 'ssh'; key: string }

export function hostGraphAliasesFor(ref: HostGraphMachineRef): HostGraphAlias[] {
  const aliases: HostGraphAlias[] = []
  if (ref.orcaHostKey) {
    aliases.push({ kind: 'orca', key: ref.orcaHostKey })
  }
  for (const key of ref.sshHostKeys ?? []) {
    aliases.push({ kind: 'ssh', key })
  }
  return aliases
}
