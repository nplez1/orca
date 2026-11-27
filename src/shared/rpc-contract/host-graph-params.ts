import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import {
  HOST_GRAPH_MAX_EDGES,
  HOST_GRAPH_MAX_HEARD,
  HOST_GRAPH_MAX_ID_CHARS,
  HOST_GRAPH_MAX_LABEL_CHARS,
  HOST_GRAPH_MAX_SSH_KEYS
} from '../host-graph/host-graph-contract'

/**
 * Params for the host-graph exchange.
 *
 * Why every field is bounded here: this is the method a paired host answers, so one compromised or
 * buggy peer must not be able to make the answer expensive or make another host's fleet count grow
 * without limit.
 */

export const HostGraphMachineRefParams = lazyZodSchema(() =>
  z.object({
    orcaHostKey: z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS).optional(),
    sshHostKeys: z
      .array(z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS))
      .max(HOST_GRAPH_MAX_SSH_KEYS)
      .optional()
  })
)

// Why no `.strict()` on the payload: an unknown key is a field a newer sender added, and rejecting
// the whole adjacency would turn a new field into a host disappearing from everyone's fleet.
// See docs/reference/remote-wire-compatibility.md.
export const HostGraphAdjacencyParams = lazyZodSchema(() =>
  z.object({
    // Why a range and not `z.literal(1)`: a newer sender's payload must reach the handler, which can
    // refuse the version by name instead of the transport reporting a schema error it retries forever.
    version: z.number().int().nonnegative(),
    self: z.object({
      ref: HostGraphMachineRefParams,
      label: z.string().min(1).max(HOST_GRAPH_MAX_LABEL_CHARS)
    }),
    edges: z
      .array(
        z.object({
          to: HostGraphMachineRefParams,
          label: z.string().min(1).max(HOST_GRAPH_MAX_LABEL_CHARS),
          kind: z.enum(['pairing-out', 'pairing-in', 'ssh']),
          liveness: z.enum(['connected', 'idle']),
          observedAt: z.number().int().nonnegative()
        })
      )
      .max(HOST_GRAPH_MAX_EDGES),
    revision: z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS),
    generatedAt: z.number().int().nonnegative()
  })
)

export const HostGraphHeardReportParams = lazyZodSchema(() =>
  z.object({
    adjacency: HostGraphAdjacencyParams,
    reportedBy: z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS),
    receivedAt: z.number().int().nonnegative()
  })
)

export const HostGraphExchangeParams = lazyZodSchema(() =>
  z
    .object({
      self: HostGraphAdjacencyParams.nullable(),
      knownRevision: z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS).optional()
    })
    .strict()
)

/**
 * A peer's answer, validated before it is composed.
 *
 * Why the result is parsed at all: `params` bounds what this host is *asked*, but a hostile or buggy
 * peer answers whatever it likes. Without this, one bad label or a missing `ref` throws inside
 * composition and the whole fan-out is lost, and an unbounded `heard` list is work nobody asked for.
 */
export const HostGraphExchangeResultParams = lazyZodSchema(() =>
  z.union([
    z.object({ unchanged: z.literal(true) }).strict(),
    z.object({
      adjacency: HostGraphAdjacencyParams,
      heard: z.array(HostGraphHeardReportParams).max(HOST_GRAPH_MAX_HEARD),
      revision: z.string().min(1).max(HOST_GRAPH_MAX_ID_CHARS)
    })
  ])
)
