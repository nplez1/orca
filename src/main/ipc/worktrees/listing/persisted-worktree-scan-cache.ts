import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  readSidecarSnapshot,
  sidecarSnapshotFile,
  withSidecarSnapshotQueue,
  writeSidecarSnapshot
} from '../../../sidecar-snapshot-file'

const SCHEMA_VERSION = 1
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const CACHE_FILE_NAME = 'orca-worktree-scan-cache.json'

type PersistedWorktreeScanEntry = {
  repoPath: string
  wslDistro: string | null
  scannedAt: number
  worktrees: GitWorktreeInfo[]
}

type PersistedWorktreeScanFile = {
  schemaVersion: typeof SCHEMA_VERSION
  entries: Record<string, PersistedWorktreeScanEntry>
}

type CachedWorktreeScan = PersistedWorktreeScanEntry & {
  repoId: string
}

const loadedFiles = new Map<string, PersistedWorktreeScanFile>()
const loadPromises = new Map<string, Promise<PersistedWorktreeScanFile>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseGitWorktreeInfo(value: unknown): GitWorktreeInfo | null {
  if (!isRecord(value)) {
    return null
  }
  const { path, head, branch, isBare, isMainWorktree } = value
  if (
    typeof path !== 'string' ||
    typeof head !== 'string' ||
    typeof branch !== 'string' ||
    typeof isBare !== 'boolean' ||
    typeof isMainWorktree !== 'boolean'
  ) {
    return null
  }

  const worktree: GitWorktreeInfo = { path, head, branch, isBare, isMainWorktree }
  for (const key of ['isSparse', 'locked', 'prunable'] as const) {
    const field = value[key]
    if (field !== undefined && typeof field !== 'boolean') {
      return null
    }
    if (field !== undefined) {
      worktree[key] = field
    }
  }
  for (const key of ['lockReason', 'prunableReason'] as const) {
    const field = value[key]
    if (field !== undefined && typeof field !== 'string') {
      return null
    }
    if (field !== undefined) {
      worktree[key] = field
    }
  }
  return worktree
}

function parseEntry(value: unknown): PersistedWorktreeScanEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const { repoPath, wslDistro, scannedAt, worktrees } = value
  if (
    typeof repoPath !== 'string' ||
    (wslDistro !== null && typeof wslDistro !== 'string') ||
    typeof scannedAt !== 'number' ||
    !Number.isFinite(scannedAt) ||
    !Array.isArray(worktrees)
  ) {
    return null
  }
  const parsedWorktrees = worktrees.map(parseGitWorktreeInfo)
  if (parsedWorktrees.some((worktree) => worktree === null)) {
    return null
  }
  return {
    repoPath,
    wslDistro,
    scannedAt,
    worktrees: parsedWorktrees.filter((worktree): worktree is GitWorktreeInfo => worktree !== null)
  }
}

function parseCache(value: unknown): PersistedWorktreeScanFile {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !isRecord(value.entries)) {
    return { schemaVersion: SCHEMA_VERSION, entries: {} }
  }
  const entries: Record<string, PersistedWorktreeScanEntry> = {}
  for (const [repoId, entry] of Object.entries(value.entries)) {
    const parsed = parseEntry(entry)
    if (parsed) {
      entries[repoId] = parsed
    }
  }
  return { schemaVersion: SCHEMA_VERSION, entries }
}

function cacheFile(profileDirectory: string): string {
  return sidecarSnapshotFile(profileDirectory, CACHE_FILE_NAME)
}

async function loadCache(file: string): Promise<PersistedWorktreeScanFile> {
  const loaded = loadedFiles.get(file)
  if (loaded) {
    return loaded
  }
  const existingLoad = loadPromises.get(file)
  if (existingLoad) {
    return existingLoad
  }
  const load = readSidecarSnapshot(file)
    .then(parseCache)
    .then((parsed) => {
      loadedFiles.set(file, parsed)
      return parsed
    })
  loadPromises.set(file, load)
  try {
    return await load
  } finally {
    loadPromises.delete(file)
  }
}

export async function readPersistedWorktreeScanCache(
  profileDirectory: string
): Promise<CachedWorktreeScan[]> {
  const file = cacheFile(profileDirectory)
  const cache = await loadCache(file)
  const cutoff = Date.now() - MAX_CACHE_AGE_MS
  return Object.entries(cache.entries)
    .filter(([, entry]) => entry.scannedAt >= cutoff)
    .map(([repoId, entry]) => ({ repoId, ...entry }))
}

export function persistWorktreeScanCacheEntry(
  profileDirectory: string,
  repoId: string,
  entry: Omit<PersistedWorktreeScanEntry, 'scannedAt'>
): Promise<void> {
  const file = cacheFile(profileDirectory)
  return withSidecarSnapshotQueue(file, async () => {
    const cache = await loadCache(file)
    const cutoff = Date.now() - MAX_CACHE_AGE_MS
    for (const [cachedRepoId, cachedEntry] of Object.entries(cache.entries)) {
      if (cachedEntry.scannedAt < cutoff) {
        delete cache.entries[cachedRepoId]
      }
    }
    cache.entries[repoId] = { ...entry, scannedAt: Date.now() }
    await mkdir(dirname(file), { recursive: true })
    await writeSidecarSnapshot(file, cache)
  }).catch((error: unknown) => {
    console.debug('[worktrees] Failed to persist worktree scan cache:', error)
  })
}

export function resetPersistedWorktreeScanCacheForTests(): void {
  loadedFiles.clear()
  loadPromises.clear()
}
