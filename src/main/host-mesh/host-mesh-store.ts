import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshSealedOffer, HostMeshState } from '../../shared/host-mesh/host-mesh-contract'
import { writeSecureJsonFileWithinLimit } from '../../shared/secure-storage/bounded-secure-json-file'
import { hardenExistingSecureFile } from '../../shared/secure-storage/secure-file'
import { createPendingBoxStore } from './host-mesh-store-pending-boxes'
import {
  emptyFile,
  peerEntrySchema,
  settingsFrom,
  stateSchema,
  storedFileSchema,
  type HostMeshMigrationRecord,
  type HostMeshPeerIndexEntry,
  type StoredFile
} from './host-mesh-store-schema'

export type { HostMeshMigrationRecord, HostMeshPeerIndexEntry, StoredFile }

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
    if (isMissingFile(error)) {
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

/** Whether a read failed because the file is not there, which is a first run rather than a fault. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A box this build cannot parse is dropped rather than carried: it can never be opened, and it is bounded. */

export type HostMeshStore = {
  read(): HostMeshState | null
  write(state: HostMeshState): void
  recordPeer(
    hostKey: string,
    entry: {
      deviceRowId?: string
      environmentId?: string
      redeemedLabel?: string
    }
  ): void
  forgetPeer(hostKey: string): void
  /**
   * Drops device rows this host has already revoked from every peer's index.
   *
   * Why the index needs this at all: an entry keeps every row ever minted for that machine, because removal
   * revokes the whole set. A row that expired unredeemed is already dead, so keeping its id only makes the
   * entry grow by one per failed offer.
   */
  forgetPeerDeviceRows(deviceRowIds: ReadonlySet<string>): void
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

  /**
   * The one read-modify-write of the peer index: a mutation is derived from the file it is about to replace, so
   * three copy-pasted versions of that sequence cannot drift apart.
   *
   * Why returning the same object means "nothing to write": the pass calls this for every row it revoked, and a
   * synchronous rewrite per row is work the render path does not need.
   */
  function mutatePeerIndex(
    update: (peerIndex: Readonly<Record<string, unknown>>) => Record<string, unknown>
  ): void {
    const file = readOrRefuse(path) ?? emptyFile()
    const next = update(file.peerIndex)
    if (next === file.peerIndex) {
      return
    }
    file.peerIndex = next
    writeStoredFile(path, file)
  }

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
      mutatePeerIndex((peerIndex) => {
        const raw = peerIndex[hostKey]
        // Merged field by field over the raw entry, so a field a newer build wrote survives a record.
        const held = isRecord(raw) ? raw : {}
        const known = peerEntrySchema.safeParse(raw)
        const deviceRowIds = known.success ? known.data.deviceRowIds : []
        const environmentId = known.success ? known.data.environmentId : null
        const redeemedLabel =
          entry.redeemedLabel ?? (known.success ? known.data.redeemedLabel : null)
        return {
          ...peerIndex,
          [hostKey]: {
            ...held,
            deviceRowIds:
              entry.deviceRowId === undefined || deviceRowIds.includes(entry.deviceRowId)
                ? deviceRowIds
                : [...deviceRowIds, entry.deviceRowId],
            environmentId: entry.environmentId ?? environmentId,
            // Why omitted when this host named nothing: an entry written before names existed keeps its own shape.
            ...(redeemedLabel === null || redeemedLabel === undefined ? {} : { redeemedLabel })
          }
        }
      })
    },

    forgetPeer: (hostKey) => {
      mutatePeerIndex((peerIndex) => {
        if (!(hostKey in peerIndex)) {
          return peerIndex
        }
        const { [hostKey]: _forgotten, ...withoutPeer } = peerIndex
        return withoutPeer
      })
    },

    forgetPeerDeviceRows: (deviceRowIds) => {
      if (deviceRowIds.size === 0) {
        return
      }
      mutatePeerIndex((peerIndex) => {
        let changed = false
        const kept: Record<string, unknown> = {}
        for (const [hostKey, raw] of Object.entries(peerIndex)) {
          const held = isRecord(raw) ? raw : {}
          const ids = Array.isArray(held.deviceRowIds) ? held.deviceRowIds : []
          const remaining = ids.filter((id) => typeof id !== 'string' || !deviceRowIds.has(id))
          if (remaining.length !== ids.length) {
            changed = true
            kept[hostKey] = { ...held, deviceRowIds: remaining }
          } else {
            kept[hostKey] = raw
          }
        }
        return changed ? kept : peerIndex
      })
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
