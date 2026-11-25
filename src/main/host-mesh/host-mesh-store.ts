import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import {
  DEFAULT_HOST_MESH_SETTINGS,
  type HostMeshSettings
} from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshSealedOffer, HostMeshState } from '../../shared/host-mesh/host-mesh-contract'
import { writeSecureJsonFileWithinLimit } from '../../shared/secure-storage/bounded-secure-json-file'
import { hardenExistingSecureFile } from '../../shared/secure-storage/secure-file'
import { createPendingBoxStore } from './host-mesh-store-pending-boxes'

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
  z.looseObject({ kind: z.literal('unreachable'), since: z.number() }),
  // A peer on a build that predates the group answers `method_not_found`, which is a state worth keeping:
  // it is what stops the repair minting offers at a machine that cannot redeem them.
  z.looseObject({ kind: z.literal('unsupported'), since: z.number() })
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

/** Partial on purpose: a build that adds a rule leaves this one's booleans at their defaults. */
const settingsSchema = z.looseObject({
  autoAcceptIntroducedMembers: z.boolean(),
  acceptIntroductions: z.boolean(),
  relayIntroductions: z.boolean(),
  allowJoins: z.boolean()
})

export type HostMeshMigrationRecord = {
  version: number
  appliedAt: number
  /** Machines the group was created from; 0 records that this install had none to group. */
  peerCount: number
}

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
  peerIndex: z.record(z.string().min(1), z.unknown()).default({}),
  /** Boxes a member asked this host to hold for a newcomer, keyed by the machine they are addressed to. */
  pendingBoxes: z.record(z.string().min(1), z.array(z.unknown())).default({}),
  /** Admission timestamps per group, kept so the introduction limit survives a restart. */
  admissions: z.record(z.string().min(1), z.array(z.number())).default({}),
  /** Box nonces already redeemed, with when, so a replay fails rather than joining twice. */
  spentNonces: z.record(z.string().min(1), z.number()).default({}),
  /** The group's own admission rules, which belong with the group rather than with this install's settings. */
  settings: z.unknown().default(null),
  /** What an upgrade found and grouped, so the panel can say where this group came from. */
  migration: z.unknown().default(null)
})
type StoredFile = z.infer<typeof storedFileSchema>

export type { StoredFile }

const emptyFile = (): StoredFile => ({
  version: 1,
  state: null,
  peerIndex: {},
  pendingBoxes: {},
  admissions: {},
  spentNonces: {},
  migration: null,
  settings: null
})

/** A value this build cannot read is the defaults, not a refusal: the rules decide who joins, not the file. */
function settingsFrom(raw: unknown): HostMeshSettings {
  const parsed = settingsSchema.partial().safeParse(raw)
  return parsed.success
    ? { ...DEFAULT_HOST_MESH_SETTINGS, ...parsed.data }
    : { ...DEFAULT_HOST_MESH_SETTINGS }
}

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
  let text: string
  try {
    hardenExistingSecureFile(path)
    text = readNodeFileSyncWithinLimit(path, MAX_HOST_MESH_STORE_BYTES).buffer.toString('utf8')
  } catch (error) {
    // A file past the cap is refused rather than read: nothing this store writes reaches it, so its
    // size is itself evidence that this build does not understand the file.
    // Why ENOENT is "missing" rather than "unreadable": a first run has no file, and that is not a fault
    // the owner should be told about — but a probe for existence is a sync fs call this process must not make.
    if ((error as { code?: string } | null)?.code === 'ENOENT') {
      return { kind: 'missing' }
    }
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

function migrationRecordOf(raw: unknown): HostMeshMigrationRecord | null {
  const parsed = z
    .object({ version: z.number(), appliedAt: z.number(), peerCount: z.number() })
    .safeParse(raw)
  return parsed.success ? parsed.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A box this build cannot parse is dropped rather than carried: it can never be opened, and it is bounded. */

export type HostMeshStore = {
  read(): HostMeshState | null
  write(state: HostMeshState): void
  recordPeer(hostKey: string, entry: { deviceRowId?: string; environmentId?: string }): void
  forgetPeer(hostKey: string): void
  readPeerIndex(): ReadonlyMap<string, HostMeshPeerIndexEntry>
  readSettings(): HostMeshSettings
  writeSettings(settings: HostMeshSettings): void
  /** What the one-time upgrade migration did, or null when it has not run in this install. */
  readMigration(): HostMeshMigrationRecord | null
  recordMigration(record: HostMeshMigrationRecord): void
  /** True when this box's nonce was already used, so a replay inside the offer window is refused. */
  hasSpentNonce(nonce: string, now: number): boolean
  spendNonce(nonce: string, now: number): void
  /** Admissions inside the last hour for a group, which is what the introduction limit counts. */
  readAdmissions(groupId: string, now: number): number[]
  recordAdmission(groupId: string, at: number): void
  /** Boxes this host is holding for a machine that has not collected them yet. */
  readPendingBoxes(recipientHostKey: string): HostMeshSealedOffer[]
  /** Returns and removes them: a box is collected once, so a re-read cannot re-redeem it. */
  takePendingBoxes(recipientHostKey: string): HostMeshSealedOffer[]
  addPendingBox(recipientHostKey: string, sealed: HostMeshSealedOffer): void
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

    // Why this refuses an unreadable file instead of replacing it: moving the file aside is how a caller
    // starts over, so an accidental write here cannot be the thing that forgot the group.
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

    readSettings: () => settingsFrom(readOrRefuse(path)?.settings),

    writeSettings: (settings) => {
      const file = readOrRefuse(path) ?? emptyFile()
      file.settings = settings
      writeStoredFile(path, file)
    },

    hasSpentNonce: (nonce, now) => {
      const file = readOrRefuse(path)
      const at = file?.spentNonces[nonce]
      // Why a window rather than forever: an offer cannot outlive it, so neither must the record.
      return at !== undefined && now - at < 60 * 60_000
    },

    spendNonce: (nonce, now) => {
      const file = readOrRefuse(path) ?? emptyFile()
      const kept = Object.entries(file.spentNonces).filter(([, at]) => now - at < 60 * 60_000)
      writeStoredFile(path, {
        ...file,
        spentNonces: { ...Object.fromEntries(kept), [nonce]: now }
      })
    },

    readMigration: () => {
      const file = readOrRefuse(path)
      return file === null ? null : migrationRecordOf(file.migration)
    },

    recordMigration: (record) => {
      const file = readOrRefuse(path) ?? emptyFile()
      writeStoredFile(path, { ...file, migration: record })
    },

    readAdmissions: (groupId, now) => {
      const file = readOrRefuse(path)
      const window = 60 * 60_000
      return (file?.admissions[groupId] ?? []).filter((at) => now - at < window)
    },

    recordAdmission: (groupId, at) => {
      const file = readOrRefuse(path) ?? emptyFile()
      const window = 60 * 60_000
      const kept = (file.admissions[groupId] ?? []).filter((entry) => at - entry < window)
      writeStoredFile(path, {
        ...file,
        admissions: { ...file.admissions, [groupId]: [...kept, at] }
      })
    },

    ...createPendingBoxStore({
      read: () => readOrRefuse(path),
      write: (file) => writeStoredFile(path, file),
      empty: emptyFile
    })
  }
}
