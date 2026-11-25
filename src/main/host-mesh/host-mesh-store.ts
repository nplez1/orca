import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { HostMeshState } from '../../shared/host-mesh/host-mesh-contract'
import { writeSecureJsonFileWithinLimit } from '../../shared/secure-storage/bounded-secure-json-file'
import { hardenExistingSecureFile } from '../../shared/secure-storage/secure-file'

/**
 * A group's state on this host: the reducer's output, plus the index removal needs.
 *
 * Why "unreadable" is a throw and "absent" is null: a file that exists and cannot be parsed may name a
 * group, so a caller that read it as "no group" would mint a second one over the top of it.
 *
 * Why the peer index is its own index rather than fields on the pairing rows: another build may rewrite
 * the device registry or `orca-environments.json` and drop what it does not know, and removal must still
 * find what to delete.
 */

export const HOST_MESH_STORE_FILE_NAME = 'host-mesh.json'

/** The same ceiling the other per-host records use; a group is at most 12 members of short rows. */
export const MAX_HOST_MESH_STORE_BYTES = 256 * 1024

export function hostMeshStorePath(userDataPath: string): string {
  return join(userDataPath, HOST_MESH_STORE_FILE_NAME)
}

const memberSchema = z.looseObject({
  hostKey: z.string().min(1),
  label: z.string(),
  introducedBy: z.string().min(1).optional(),
  addedAtEpoch: z.number()
})

const tombstoneSchema = z.looseObject({
  hostKey: z.string().min(1),
  epoch: z.number(),
  removedBy: z.string().min(1)
})

const outboundLinkSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('ok') }),
  z.looseObject({
    kind: z.literal('awaitingOffer'),
    requestedAtEpoch: z.number(),
    expiresAt: z.number()
  }),
  z.looseObject({
    kind: z.literal('redeemFailed'),
    reason: z.string(),
    attempts: z.number(),
    retryAt: z.number()
  }),
  z.looseObject({ kind: z.literal('unreachable'), since: z.number() })
])

const inboundLinkSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('active') }),
  z.looseObject({ kind: z.literal('awaitingRedeem'), expiresAt: z.number() }),
  z.looseObject({ kind: z.literal('absent') })
])

const stateSchema = z.looseObject({
  groupId: z.string(),
  epoch: z.number(),
  selfKey: z.string().min(1),
  members: z.array(memberSchema),
  tombstones: z.array(tombstoneSchema),
  links: z.looseObject({
    outbound: z.record(z.string().min(1), outboundLinkSchema),
    inbound: z.record(z.string().min(1), inboundLinkSchema)
  })
})

const peerEntrySchema = z.looseObject({
  deviceRowIds: z.array(z.string().min(1)),
  environmentId: z.string().min(1).nullable()
})

export type HostMeshPeerIndexEntry = {
  deviceRowIds: readonly string[]
  environmentId: string | null
}

/**
 * `peerIndex` values are held as `unknown` so an entry a newer build wrote is carried back out verbatim:
 * this build cannot parse it, and deleting it would forget the device rows removal has to delete.
 */
const storedFileSchema = z.looseObject({
  version: z.literal(1),
  state: z.unknown(),
  peerIndex: z.record(z.string().min(1), z.unknown()).default({})
})

type StoredFile = z.infer<typeof storedFileSchema>

const emptyFile = (): StoredFile => ({ version: 1, state: null, peerIndex: {} })

export class HostMeshStoreUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(
      `Orca cannot read ${path} (${reason}), so it left it as it is: that file may name a group. Move it aside to start over.`
    )
    this.name = 'HostMeshStoreUnreadableError'
  }
}

type StoredFileRead =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'parsed'; file: StoredFile }

function readStoredFile(path: string): StoredFileRead {
  if (!existsSync(path)) {
    return { kind: 'missing' }
  }
  let text: string
  try {
    hardenExistingSecureFile(path)
    text = readNodeFileSyncWithinLimit(path, MAX_HOST_MESH_STORE_BYTES).buffer.toString('utf8')
  } catch (error) {
    // A file past the cap is refused rather than read: nothing this store writes reaches it, so its
    // size is itself evidence that this build does not understand the file.
    return {
      kind: 'unreadable',
      reason: error instanceof Error ? error.message : 'it could not be read'
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', reason: 'it is not JSON' }
  }
  const file = storedFileSchema.safeParse(parsed)
  if (!file.success) {
    return { kind: 'unreadable', reason: 'it is not a host mesh record this build knows' }
  }
  return { kind: 'parsed', file: file.data }
}

/** Null only when there is no file at all. */
function readOrRefuse(path: string): StoredFile | null {
  const read = readStoredFile(path)
  if (read.kind === 'missing') {
    return null
  }
  if (read.kind === 'unreadable') {
    throw new HostMeshStoreUnreadableError(path, read.reason)
  }
  return read.file
}

function writeStoredFile(path: string, file: StoredFile): void {
  writeSecureJsonFileWithinLimit(path, file, MAX_HOST_MESH_STORE_BYTES, { durable: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type HostMeshStore = {
  read(): HostMeshState | null
  write(state: HostMeshState): void
  recordPeer(hostKey: string, entry: { deviceRowId?: string; environmentId?: string }): void
  forgetPeer(hostKey: string): void
  readPeerIndex(): ReadonlyMap<string, HostMeshPeerIndexEntry>
  clear(): void
}

export function createHostMeshStore({ userDataPath }: { userDataPath: string }): HostMeshStore {
  const path = hostMeshStorePath(userDataPath)

  return {
    read: () => {
      const file = readOrRefuse(path)
      if (file === null || file.state === undefined || file.state === null) {
        return null
      }
      const state = stateSchema.safeParse(file.state)
      if (!state.success) {
        throw new HostMeshStoreUnreadableError(
          path,
          'the group state in it is not one this build knows'
        )
      }
      return state.data
    },

    // Why this refuses an unreadable file instead of replacing it: `clear` is how a caller starts over,
    // so an accidental write here cannot be the thing that forgot the group.
    write: (state) => {
      const file = readOrRefuse(path) ?? emptyFile()
      file.state = state
      writeStoredFile(path, file)
    },

    recordPeer: (hostKey, entry) => {
      const file = readOrRefuse(path) ?? emptyFile()
      const raw = file.peerIndex[hostKey]
      // Merged field by field over the raw entry, so a field a newer build wrote survives a record.
      const held = isRecord(raw) ? raw : {}
      const known = peerEntrySchema.safeParse(raw)
      const deviceRowIds = known.success ? known.data.deviceRowIds : []
      const environmentId = known.success ? known.data.environmentId : null
      file.peerIndex = {
        ...file.peerIndex,
        [hostKey]: {
          ...held,
          deviceRowIds:
            entry.deviceRowId === undefined || deviceRowIds.includes(entry.deviceRowId)
              ? deviceRowIds
              : [...deviceRowIds, entry.deviceRowId],
          environmentId: entry.environmentId ?? environmentId
        }
      }
      writeStoredFile(path, file)
    },

    forgetPeer: (hostKey) => {
      const file = readOrRefuse(path) ?? emptyFile()
      if (!(hostKey in file.peerIndex)) {
        return
      }
      const { [hostKey]: _forgotten, ...peerIndex } = file.peerIndex
      file.peerIndex = peerIndex
      writeStoredFile(path, file)
    },

    readPeerIndex: () => {
      const file = readOrRefuse(path)
      const index = new Map<string, HostMeshPeerIndexEntry>()
      for (const [hostKey, raw] of Object.entries(file?.peerIndex ?? {})) {
        const entry = peerEntrySchema.safeParse(raw)
        if (entry.success) {
          index.set(hostKey, entry.data)
        }
      }
      return index
    },

    clear: () => {
      rmSync(path, { force: true })
    }
  }
}
