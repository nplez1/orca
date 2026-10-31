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
  planWorktreeCaseSplitMerge,
  rekeySessionWithoutOverwrite
} from './worktree-case-split-merge'

export type FileIdentity = { dev: number | bigint; ino: number | bigint }

export type WorktreeCaseSplitStore = Pick<RuntimeStore, 'setWorktreeMeta'> & {
  removeWorktreeMeta?: RuntimeStore['removeWorktreeMeta']
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

function rekeySession(
  deps: WorktreeCaseSplitDeps,
  hostId: ExecutionHostId,
  pair: CaseSplitPair,
  log: (message: string) => void
): void {
  const { getWorkspaceSession, setWorkspaceSession } = deps.store
  if (!getWorkspaceSession || !setWorkspaceSession) {
    log(
      `[worktree-identity-merge] session not re-keyed for ${pair.siblingId}: store has no session access`
    )
    return
  }
  const result = rekeySessionWithoutOverwrite(
    getWorkspaceSession(hostId),
    pair.siblingId,
    pair.survivorId
  )
  if (result.keptFields.length > 0) {
    log(
      `[worktree-identity-merge] survivor ${pair.survivorId} already owns ${result.keptFields.join(', ')}; left ${pair.siblingId}'s entries in place`
    )
  }
  if (result.changed) {
    setWorkspaceSession(result.session, hostId)
  }
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
  for (const pair of candidates) {
    const survivor = input.metaById[pair.survivorId]
    const sibling = input.metaById[pair.siblingId]
    if (!survivor || !sibling || !(await spellingsShareOneDirectory(pair, statIdentity))) {
      continue
    }
    const updates = planWorktreeCaseSplitMerge(survivor, sibling, {
      branch: pair.branch,
      survivorPath: pair.survivorPath,
      siblingId: pair.siblingId
    })
    try {
      deps.store.setWorktreeMeta(
        hostWorktreeTarget({ id: pair.survivorId, hostId: input.hostId }),
        updates
      )
      rekeySession(deps, input.hostId, pair, log)
      removeWorktreeMeta(hostWorktreeTarget({ id: pair.siblingId, hostId: input.hostId }))
    } catch (error) {
      log(
        `[worktree-identity-merge] failed ${pair.siblingId} -> ${pair.survivorId}: ${String(error)}`
      )
      continue
    }
    log(
      `[worktree-identity-merge] merged ${pair.siblingId} into ${pair.survivorId}; moved ${Object.keys(updates).join(', ') || 'nothing'}`
    )
    merged.push(pair.siblingId)
  }
  return merged
}

/** Listing hook: local checkouts only, since the inode proof needs this machine's filesystem. */
export async function reconcileListedWorktreeCaseSplits(
  store: WorktreeCaseSplitStore & Pick<RuntimeStore, 'getAllWorktreeMeta'>,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
  listed: readonly { path: string; branch: string }[]
): Promise<void> {
  const hostId = getRepoExecutionHostId(repo)
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  try {
    await reconcileWorktreeCaseSplits(
      { repoId: repo.id, hostId, listed, metaById: store.getAllWorktreeMeta() ?? {} },
      { store }
    )
  } catch (error) {
    console.warn('[worktree-identity-merge] reconciliation skipped:', error)
  }
}
