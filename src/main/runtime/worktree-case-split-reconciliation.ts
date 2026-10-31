import { stat } from 'node:fs/promises'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { composeWorktreeId, splitWorktreeId } from '../../shared/worktree/id'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RuntimeStore } from './runtime-store-contract'
import {
  moveSessionToSurvivor,
  planWorktreeCaseSplitMerge,
  sessionOwnsWorktree
} from './worktree-case-split-merge'

export type FileIdentity = { dev: number | bigint; ino: number | bigint }

export type WorktreeCaseSplitStore = Pick<RuntimeStore, 'setWorktreeMeta'> & {
  removeWorktreeMeta?: RuntimeStore['removeWorktreeMeta']
  getWorktreeMeta?: RuntimeStore['getWorktreeMeta']
  getWorkspaceSession?: (hostId?: string | null) => WorkspaceSessionState
  setWorkspaceSession?: (session: WorkspaceSessionState, hostId?: string | null) => void
}

export type WorktreeCaseSplitInput = {
  repoId: string
  hostId: ExecutionHostId
  /** The scan's checkouts; their spelling is the id the sidebar lists. */
  listed: readonly { path: string; branch: string }[]
  /** Metadata keyed by raw worktree id; rows owned by another host are ignored. */
  metaById: Readonly<Record<string, WorktreeMeta>>
}

export type WorktreeCaseSplitDeps = {
  store: WorktreeCaseSplitStore
  statIdentity?: (path: string) => Promise<FileIdentity>
  log?: (message: string) => void
  /** Re-keys the renderer instead of letting its next session write re-create the twin's tabs. */
  notifyWorktreeRenamed?: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
}

/** A pair that cannot merge must not be re-stat'ed on every later scan; retry once it may have changed. */
const REFUSAL_TTL_MS = 10 * 60 * 1000
const refusedPairsBySurvivor = new Map<string, number>()

/** Why a reset exists: the refusal cache outlives a test's harness, like other probe caches here. */
export function resetWorktreeCaseSplitRefusalsForTests(): void {
  refusedPairsBySurvivor.clear()
}

function refusalKey(pair: CaseSplitPair): string {
  return `${pair.survivorId}\u0000${pair.siblingId}`
}

function isRefusedNow(pair: CaseSplitPair, now: number): boolean {
  const refusedAt = refusedPairsBySurvivor.get(refusalKey(pair))
  if (refusedAt === undefined) {
    return false
  }
  if (now - refusedAt < REFUSAL_TTL_MS) {
    return true
  }
  refusedPairsBySurvivor.delete(refusalKey(pair))
  return false
}

type CaseSplitPair = {
  survivorId: string
  siblingId: string
  survivorPath: string
  siblingPath: string
  branch: string
}

function isOwnedByHost(meta: WorktreeMeta | undefined, hostId: ExecutionHostId): boolean {
  return meta !== undefined && (meta.hostId === undefined || meta.hostId === hostId)
}

/** Unlisted same-repo records whose path folds onto a listed checkout; pure, no filesystem. */
export function findWorktreeCaseSplitCandidates(input: WorktreeCaseSplitInput): CaseSplitPair[] {
  const listedExact = new Set(input.listed.map((worktree) => worktree.path))
  const listedByFolded = new Map(
    input.listed.map((worktree) => [worktree.path.toLowerCase(), worktree])
  )
  const pairs: CaseSplitPair[] = []
  for (const siblingId of Object.keys(input.metaById)) {
    const parsed = splitWorktreeId(siblingId)
    if (
      !parsed ||
      parsed.repoId !== input.repoId ||
      listedExact.has(parsed.worktreePath) ||
      !isOwnedByHost(input.metaById[siblingId], input.hostId)
    ) {
      continue
    }
    const survivor = listedByFolded.get(parsed.worktreePath.toLowerCase())
    if (!survivor) {
      continue
    }
    const survivorId = composeWorktreeId(input.repoId, survivor.path)
    if (!isOwnedByHost(input.metaById[survivorId], input.hostId)) {
      continue
    }
    pairs.push({
      survivorId,
      siblingId,
      survivorPath: survivor.path,
      siblingPath: parsed.worktreePath,
      branch: survivor.branch
    })
  }
  return pairs
}

async function defaultStatIdentity(path: string): Promise<FileIdentity> {
  const stats = await stat(path, { bigint: true })
  return { dev: stats.dev, ino: stats.ino }
}

/** Both spellings must name one directory; a missing path or a zero inode is no proof. */
async function spellingsShareOneDirectory(
  pair: CaseSplitPair,
  statIdentity: (path: string) => Promise<FileIdentity>
): Promise<boolean> {
  try {
    const [survivor, sibling] = await Promise.all([
      statIdentity(pair.survivorPath),
      statIdentity(pair.siblingPath)
    ])
    return (
      String(survivor.ino) !== '0' &&
      String(survivor.dev) === String(sibling.dev) &&
      String(survivor.ino) === String(sibling.ino)
    )
  } catch {
    return false
  }
}

function readCurrentMeta(
  deps: WorktreeCaseSplitDeps,
  input: WorktreeCaseSplitInput,
  worktreeId: string
): WorktreeMeta | undefined {
  return deps.store.getWorktreeMeta?.(worktreeId) ?? input.metaById[worktreeId]
}

/** Fold each case-split twin record into the listed survivor, once, under a same-inode proof. */
export async function reconcileWorktreeCaseSplits(
  input: WorktreeCaseSplitInput,
  deps: WorktreeCaseSplitDeps
): Promise<string[]> {
  const candidates = findWorktreeCaseSplitCandidates(input)
  const removeWorktreeMeta = deps.store.removeWorktreeMeta
  if (candidates.length === 0 || !removeWorktreeMeta) {
    return []
  }
  const statIdentity = deps.statIdentity ?? defaultStatIdentity
  const log = deps.log ?? console.info
  const merged: string[] = []
  const now = Date.now()
  for (const pair of candidates) {
    if (isRefusedNow(pair, now)) {
      continue
    }
    if (!(await spellingsShareOneDirectory(pair, statIdentity))) {
      refusedPairsBySurvivor.set(refusalKey(pair), now)
      continue
    }
    // Re-read after the await: a rename made while stat ran must not be overwritten by this plan.
    const survivor = readCurrentMeta(deps, input, pair.survivorId)
    const sibling = readCurrentMeta(deps, input, pair.siblingId)
    if (!survivor || !sibling) {
      continue
    }
    const updates = planWorktreeCaseSplitMerge(survivor, sibling, {
      branch: pair.branch,
      survivorPath: pair.survivorPath,
      siblingId: pair.siblingId
    })
    const transferred: string[] = []
    let keptTwin: string | null = null
    const session = deps.store.getWorkspaceSession?.(input.hostId)
    if (session && sessionOwnsWorktree(session, pair.siblingId)) {
      // The twin's removal deletes whatever session state is still under its id, so the tab set
      // moves as one unit or the twin record stays.
      if (!deps.notifyWorktreeRenamed) {
        keptTwin = 'no renderer notification available'
      } else {
        const move = moveSessionToSurvivor(session, pair.siblingId, pair.survivorId)
        if (!move.moved) {
          keptTwin = 'survivor already owns a session'
        } else {
          deps.store.setWorkspaceSession?.(move.session, input.hostId)
          transferred.push('session')
        }
      }
    }
    try {
      deps.store.setWorktreeMeta(
        hostWorktreeTarget({ id: pair.survivorId, hostId: input.hostId }),
        updates
      )
      if (keptTwin) {
        log(
          `[worktree-identity-merge] took metadata from ${pair.siblingId} into ${pair.survivorId}; kept the twin record: ${keptTwin}`
        )
        continue
      }
      if (transferred.length > 0) {
        // Why after the move and before the removal: a live renderer holding the twin's tabs would
        // otherwise write them back under an id this step is about to delete.
        deps.notifyWorktreeRenamed?.(input.repoId, pair.siblingId, pair.survivorId)
      }
      removeWorktreeMeta(hostWorktreeTarget({ id: pair.siblingId, hostId: input.hostId }))
    } catch (error) {
      log(
        `[worktree-identity-merge] failed ${pair.siblingId} -> ${pair.survivorId}: ${String(error)}`
      )
      continue
    }
    log(
      `[worktree-identity-merge] merged ${pair.siblingId} into ${pair.survivorId}; moved ${[...Object.keys(updates), ...transferred].join(', ') || 'nothing'}`
    )
    merged.push(pair.siblingId)
  }
  return merged
}

/** Listing hook: local checkouts only, since the inode proof needs this machine's filesystem. */
export async function reconcileListedWorktreeCaseSplits(
  store: WorktreeCaseSplitStore,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  listed: readonly { path: string; branch: string }[],
  notifyWorktreeRenamed: ((repoId: string, oldWorktreeId: string, newWorktreeId: string) => void) | undefined,
  /** The caller's already-read rows: a healthy scan must not read persisted metadata twice. */
  metaById: Readonly<Record<string, WorktreeMeta>> | undefined
): Promise<void> {
  const hostId = getRepoExecutionHostId(repo)
  // Without the caller's rows there is nothing to detect against, and reading them here would add
  // a metadata read to every scan of every repo.
  if (hostId !== LOCAL_EXECUTION_HOST_ID || !metaById) {
    return
  }
  try {
    await reconcileWorktreeCaseSplits(
      { repoId: repo.id, hostId, listed, metaById },
      { store, ...(notifyWorktreeRenamed ? { notifyWorktreeRenamed } : {}) }
    )
  } catch (error) {
    console.warn('[worktree-identity-merge] reconciliation skipped:', error)
  }
}
