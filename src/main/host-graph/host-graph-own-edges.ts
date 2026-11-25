import { createHash } from 'node:crypto'
import {
  HOST_GRAPH_MAX_EDGES,
  HOST_GRAPH_MAX_LABEL_CHARS,
  HOST_GRAPH_MAX_SSH_KEYS,
  HOST_GRAPH_PAYLOAD_VERSION,
  type HostGraphAdjacency,
  type HostGraphEdge,
  type HostGraphMachineRef
} from '../../shared/host-graph/host-graph-contract'
import { hostGraphRevision } from '../../shared/host-graph/host-graph-compose'
import {
  getPreferredPairedRuntimeConnection,
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'

/**
 * This machine's own adjacency: itself, and the edges it owns.
 *
 * Why every reading is an argument: the interesting rules here are redaction and what does not become
 * an edge, and both must be checkable without Electron, a home directory or an SSH stack.
 */

/** The fields of a saved pairing this needs; a stored environment is assignable as-is. */
export type HostGraphOwnEdgeEnvironment = Pick<
  KnownRuntimeEnvironment,
  'id' | 'name' | 'endpoints' | 'preferredEndpointId'
> &
  Partial<Pick<KnownRuntimeEnvironment, 'source' | 'sshAccess' | 'orcadDeployment'>>

/** The fields of a registered SSH target this needs; an `SshTarget` is assignable as-is. */
export type HostGraphOwnEdgeSshTarget = {
  id: string
  label?: string
  host?: string
  port?: number
}

export type HostGraphTrustedHostKey = { host: string; port: number; fingerprint: string }

export type HostGraphOwnEdgeSources = {
  now: number
  self: { label: string; orcaHostKey?: string; sshHostKeys?: string[] }
  /** Paired runtime environments this machine holds. */
  environments: readonly HostGraphOwnEdgeEnvironment[]
  /** SSH targets registered in this install. */
  sshTargets: readonly HostGraphOwnEdgeSshTarget[]
  /** Fingerprints from the SSH host-key store, keyed `host:port`. */
  trustedHostKeys: readonly HostGraphTrustedHostKey[]
  /** Which SSH target ids have a live connection right now. Environment ids are read from it too. */
  connectedSshTargetIds: readonly string[]
}

const UNNAMED_LABEL = 'unnamed host'

export function buildOwnAdjacency(deps: HostGraphOwnEdgeSources): HostGraphAdjacency {
  const connected = new Set(deps.connectedSshTargetIds)
  const edges: HostGraphEdge[] = []

  for (const environment of deps.environments) {
    // Why excluded: a recipe VM is a workspace scratch host, not a machine the user owns.
    if (environment.source === 'ephemeral-vm') {
      continue
    }
    const tunnelTargetId = getRuntimeSshAccess(environment)?.sshTargetId
    const to = machineRef(orcaHostKeyOf(environment), sshHostKeysOfTarget(tunnelTargetId, deps))
    if (!to.orcaHostKey && !to.sshHostKeys) {
      continue
    }
    edges.push({
      to,
      label: labelOf(environment.name),
      kind: 'pairing-out',
      liveness:
        connected.has(environment.id) ||
        (tunnelTargetId !== undefined && connected.has(tunnelTargetId))
          ? 'connected'
          : 'idle',
      observedAt: deps.now
    })
  }

  for (const target of deps.sshTargets) {
    const sshHostKeys = sshHostKeysOfTarget(target.id, deps)
    // Why required: generated config lists every host the user ever wrote, and a never-connected entry
    // has no key to name the machine by, so it would be a row with nothing in it.
    if (sshHostKeys.length === 0) {
      continue
    }
    edges.push({
      to: machineRef(undefined, sshHostKeys),
      // Why not the host itself as a fallback: an address is how you reach a machine, which is the one
      // thing this payload never discloses.
      label: labelOf(target.label || ''),
      kind: 'ssh',
      liveness: connected.has(target.id) ? 'connected' : 'idle',
      observedAt: deps.now
    })
  }

  const self = {
    ref: machineRef(deps.self.orcaHostKey, deps.self.sshHostKeys ?? []),
    label: labelOf(deps.self.label)
  }
  const bounded = edges.slice(0, HOST_GRAPH_MAX_EDGES)
  return {
    version: HOST_GRAPH_PAYLOAD_VERSION,
    self,
    edges: bounded,
    revision: hostGraphRevision({ self, edges: bounded }),
    generatedAt: deps.now
  }
}

/**
 * Why the digest and not the key: it is the same `sha256(hostPublicKeyB64)[:32]` that
 * `publicRuntimeEnvironmentWithHostKey` shows in Settings, so a peer comparing two hosts sees one id.
 */
function orcaHostKeyOf(environment: HostGraphOwnEdgeEnvironment): string | undefined {
  if (environment.endpoints.length === 0) {
    return undefined
  }
  const publicKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
  return publicKey ? createHash('sha256').update(publicKey).digest('hex').slice(0, 32) : undefined
}

function sshHostKeysOfTarget(
  targetId: string | undefined,
  deps: HostGraphOwnEdgeSources
): string[] {
  if (targetId === undefined) {
    return []
  }
  const target = deps.sshTargets.find((candidate) => candidate.id === targetId)
  if (!target?.host) {
    return []
  }
  const host = normalizeHost(target.host)
  const forHost = deps.trustedHostKeys.filter((record) => normalizeHost(record.host) === host)
  // Why exact when a port is known: a different port on the same hostname is a different sshd, and a
  // never-connected target borrowing another one's key invents a machine that does not exist.
  const matches =
    target.port === undefined ? forHost : forHost.filter((record) => record.port === target.port)
  return [...new Set(matches.map((record) => record.fingerprint))].slice(0, HOST_GRAPH_MAX_SSH_KEYS)
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

/**
 * Why an allowlist and not a spread: an environment object carries its device token, its pairing public
 * key and the endpoint that reaches it, and a peer holding any of those can dial the machine.
 */
function machineRef(
  orcaHostKey: string | undefined,
  sshHostKeys: readonly string[]
): HostGraphMachineRef {
  const keys = [...new Set(sshHostKeys)].slice(0, HOST_GRAPH_MAX_SSH_KEYS)
  return {
    ...(orcaHostKey ? { orcaHostKey } : {}),
    ...(keys.length > 0 ? { sshHostKeys: keys } : {})
  }
}

function labelOf(label: string): string {
  const trimmed = label.trim().slice(0, HOST_GRAPH_MAX_LABEL_CHARS)
  return trimmed || UNNAMED_LABEL
}
