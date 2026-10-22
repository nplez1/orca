import { translate } from '@/i18n/i18n'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import {
  buildHostLabelById,
  getHostContextLabel
} from '../../../../../../shared/worktree/host-context-labels'
import {
  findIndexedDetectedWorktrees,
  findIndexedWorktreeOwner,
  worktreeOwnerHostIds
} from '@/lib/worktree-runtime-owner-index'
import type { AppState } from '../../../types'
import { applyWorktreeUpdates } from '../../worktree-meta-update-application'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import { tryRuntimeTargetForWorktreeOwner } from '../listing/worktree-owner-target'
import { persistWorktreeMeta } from './worktree-meta-persist'

type RenamedRows = Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>

/** One host's copy of the workspace being renamed, and how to reach the store that owns it. */
export type WorktreeRenameTarget = {
  hostId: ExecutionHostId
  /** Null when the host publishes the workspace but no transport resolves; it cannot be written. */
  target: RuntimeClientTarget | null
}

type PreviousName = { displayName: string; displayNameMode?: 'fixed' | 'automatic' }

export type WorktreeRenamePlan = {
  displayName: string
  /** The host the caller's own full-payload write covers. */
  primary: WorktreeRenameTarget | null
  /** Every other host that publishes the workspace, including ones that cannot be reached. */
  others: readonly WorktreeRenameTarget[]
  /** What each of those hosts still holds, so a refusal can go back to it. */
  previousByHost: ReadonlyMap<ExecutionHostId, PreviousName>
  /** Names the other hosts' rows ahead of the writes, and only with the name. */
  applyOptimistic: (state: AppState) => RenamedRows
}

export type WorktreeRenameSettlement = {
  /** Why the caller's own write failed, for the caller's existing failure handling. */
  primaryError: { reason: unknown } | null
  failure: {
    result: { ok: false; error: string }
    revertPatch: (state: AppState) => Partial<AppState>
  } | null
}

const RENAME_FIELDS = [
  'displayName',
  'displayNameIsPinned'
] as const satisfies readonly (keyof WorktreeMeta)[]

/** The name and the state that travels with it — never the rest of a mixed metadata update. */
function renameFieldsOf(updates: Partial<WorktreeMeta>): Partial<WorktreeMeta> {
  const fields: Partial<WorktreeMeta> = {}
  for (const key of RENAME_FIELDS) {
    if (key in updates) {
      Object.assign(fields, { [key]: updates[key] })
    }
  }
  return fields
}

/**
 * Every execution host that publishes `worktreeId` here (STA-4343): a repo registered on two hosts
 * is two rows sharing one id, a paired HUB's row names both its SSH route and the runtime route that
 * reaches it, and a workspace found-but-not-yet-registered is published by a detected row. One
 * sidebar row can therefore be a workspace that lives on several hosts.
 */
function worktreeRenameHostIds(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>,
  worktreeId: string
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  const published = [
    ...(state.worktreesByRepo[getRepoIdFromWorktreeId(worktreeId)] ?? []).filter(
      (row) => row.id === worktreeId
    ),
    ...findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, worktreeId)
  ]
  for (const row of published) {
    for (const hostId of worktreeOwnerHostIds(row)) {
      hostIds.add(hostId)
    }
  }
  return [...hostIds]
}

/**
 * One write per store rather than one per host id: the local app owns `local` and every directly
 * dialed `ssh:` host (host-qualified rows in one store), while a paired server owns its environment
 * however many routes reach it.
 */
function worktreeRenameTargets(
  state: AppState,
  worktreeId: string,
  hostIds: readonly ExecutionHostId[],
  preferredHostId: ExecutionHostId | undefined
): WorktreeRenameTarget[] {
  const targets = new Map<string, WorktreeRenameTarget>()
  for (const hostId of hostIds) {
    const target = tryRuntimeTargetForWorktreeOwner(state, worktreeId, hostId)
    if (!target) {
      targets.set(`unresolved\0${hostId}`, { hostId, target: null })
      continue
    }
    // Why the host id only for a local target: it is the key that store writes under, so two SSH
    // hosts stay two rows. One environment keeps one store however many host ids name it.
    const key =
      target.kind === 'local' ? `local\0${hostId}` : `environment\0${target.environmentId}`
    const existing = targets.get(key)
    // Why preferred: the caller's own host must stay addressable, or its store is written twice and
    // a failure is reported against a host the user never touched.
    if (!existing || hostId === preferredHostId) {
      targets.set(key, { hostId, target })
    }
  }
  return [...targets.values()]
}

/**
 * What a metadata update owes the other hosts when it renames the workspace, or null when it is not
 * a rename. A name belongs to the workspace, not to one host's copy of it.
 */
export function planWorktreeRename(
  state: AppState,
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  executionHostId?: ExecutionHostId
): WorktreeRenamePlan | null {
  const displayName = typeof updates.displayName === 'string' ? updates.displayName : null
  if (displayName === null) {
    return null
  }
  const primaryHostId =
    executionHostId ?? findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)?.hostId
  const targets = worktreeRenameTargets(
    state,
    worktreeId,
    worktreeRenameHostIds(state, worktreeId),
    primaryHostId
  )
  // Why the single-target case first: one store reachable through several host ids is one entry,
  // and calling it an extra would write that store twice.
  const primary =
    targets.length === 1
      ? targets[0]
      : (targets.find((entry) => entry.hostId === primaryHostId) ?? null)
  const others = targets.filter((entry) => entry !== primary)
  const previousByHost = new Map<ExecutionHostId, PreviousName>()
  for (const { hostId } of others) {
    const row = findKnownWorktreeById(state, worktreeId, hostId)
    if (typeof row?.displayName === 'string') {
      previousByHost.set(hostId, {
        displayName: row.displayName,
        displayNameMode: row.displayNameMode
      })
    }
  }
  const renameFields = renameFieldsOf(updates)
  return {
    displayName,
    primary,
    others,
    previousByHost,
    applyOptimistic: (target) => renameOtherHostRows(target, worktreeId, renameFields)
  }
}

/**
 * Every row that publishes the workspace shows the new name immediately; only the caller's own row
 * takes the rest of a mixed update, which the other hosts never receive. Host-agnostic on purpose:
 * two host ids can reach one store, and the row of the id that did not survive deduplication still
 * publishes the workspace.
 */
function renameOtherHostRows(
  state: AppState,
  worktreeId: string,
  renameFields: Partial<WorktreeMeta>
): RenamedRows {
  const worktreesByRepo = applyWorktreeUpdates(state.worktreesByRepo, worktreeId, renameFields)
  const detectedWorktreesByRepo = applyDetectedWorktreeUpdates(
    state.detectedWorktreesByRepo,
    worktreeId,
    renameFields
  )
  return worktreesByRepo === state.worktreesByRepo &&
    detectedWorktreesByRepo === state.detectedWorktreesByRepo
    ? state
    : { worktreesByRepo, detectedWorktreesByRepo }
}

/**
 * Gives every other host the same name, started together with the caller's own write so the whole
 * fleet is in flight at once: "all hosts" means one rename, not one round trip per host the user
 * waits through, and not a fan-out that only happens if the caller's own host happened to answer
 * first. Best effort by design — a host that refuses keeps its old name, is reverted locally so no
 * row claims a name its host rejected, and is named in the error; refetching instead would undo the
 * hosts that did take it.
 */
export async function settleWorktreeRename(args: {
  state: AppState
  worktreeId: string
  plan: WorktreeRenamePlan
  writePrimary: () => Promise<void>
}): Promise<WorktreeRenameSettlement> {
  // Why started first and synchronously: the host the user edited is the one they are waiting on,
  // and a synchronous throw from it must read as a rejection below rather than escape the fan-out.
  let primaryWrite: Promise<void>
  try {
    primaryWrite = args.writePrimary()
  } catch (error) {
    primaryWrite = Promise.reject(error)
  }
  const writes = [
    primaryWrite,
    ...args.plan.others.map(({ hostId, target }) =>
      target
        ? persistWorktreeMeta(
            target,
            args.worktreeId,
            { displayName: args.plan.displayName },
            hostId,
            findKnownWorktreeById(args.state, args.worktreeId, hostId)?.identity?.key
          )
        : Promise.reject(new Error(`No transport resolves for host ${hostId}.`))
    )
  ]
  const outcomes = await Promise.allSettled(writes)
  const primaryOutcome = outcomes[0]
  const failures: { hostId: ExecutionHostId; error: unknown }[] = []
  args.plan.others.forEach(({ hostId }, index) => {
    const outcome = outcomes[index + 1]
    if (outcome && outcome.status === 'rejected') {
      failures.push({ hostId, error: outcome.reason })
    }
  })
  for (const failure of failures) {
    console.error('Failed to rename worktree on host:', failure.hostId, failure.error)
  }
  return {
    primaryError: primaryOutcome?.status === 'rejected' ? { reason: primaryOutcome.reason } : null,
    failure:
      failures.length === 0
        ? null
        : {
            result: { ok: false, error: describeWorktreeRenameFailures(args.state, failures) },
            revertPatch: (state) =>
              reintroducePreviousNames(state, args.worktreeId, args.plan, failures)
          }
  }
}

/**
 * A row goes back to the name its host still holds, and only while it still shows the name this
 * attempt wrote: a rename that started later, or a refetch, owns the row now.
 */
function reintroducePreviousNames(
  state: AppState,
  worktreeId: string,
  plan: WorktreeRenamePlan,
  failures: readonly { hostId: ExecutionHostId }[]
): Partial<AppState> {
  let worktreesByRepo = state.worktreesByRepo
  let detectedWorktreesByRepo = state.detectedWorktreesByRepo
  for (const { hostId } of failures) {
    const previous = plan.previousByHost.get(hostId)
    if (
      !previous ||
      findKnownWorktreeById(state, worktreeId, hostId)?.displayName !== plan.displayName
    ) {
      continue
    }
    const revert = {
      displayName: previous.displayName,
      displayNameIsPinned: previous.displayNameMode === 'fixed'
    }
    worktreesByRepo = applyWorktreeUpdates(worktreesByRepo, worktreeId, revert, hostId)
    detectedWorktreesByRepo = applyDetectedWorktreeUpdates(
      detectedWorktreesByRepo,
      worktreeId,
      revert,
      hostId
    )
  }
  return worktreesByRepo === state.worktreesByRepo &&
    detectedWorktreesByRepo === state.detectedWorktreesByRepo
    ? // Why the same object: zustand skips notifying when the updater returns the state it was given.
      state
    : { worktreesByRepo, detectedWorktreesByRepo }
}

/** A message naming the hosts that did not take the new name, deduped by the label they show as. */
function describeWorktreeRenameFailures(
  state: Pick<AppState, 'sshTargetLabels' | 'runtimeEnvironments' | 'settings'>,
  failures: readonly { hostId: ExecutionHostId }[]
): string {
  const labels = buildWorktreeRenameHostLabels(state)
  const hosts = [
    ...new Set(
      failures.map((failure) => getHostContextLabel(failure.hostId, { hostLabelById: labels }))
    )
  ].join(', ')
  return translate(
    'auto.store.slices.worktrees.metadata.worktree.rename.across.hosts.3b80b33a5a',
    'Renamed on every other host, but {{hosts}} did not take the new name.',
    { hosts }
  )
}

/**
 * The label the sidebar shows for each host, so a failure names the host the user can go and look
 * at instead of an unreadable `runtime:<id>`. Overrides win, then the paired machine's own name.
 */
function buildWorktreeRenameHostLabels(
  state: Pick<AppState, 'sshTargetLabels' | 'runtimeEnvironments' | 'settings'>
): Map<ExecutionHostId, string> {
  const labels = buildHostLabelById({
    sshTargets: [...(state.sshTargetLabels ?? new Map<string, string>())].map(([id, label]) => ({
      id,
      label
    })),
    hostSettingOverrides: state.settings?.hostSettingOverrides
  })
  for (const environment of state.runtimeEnvironments ?? []) {
    const name = environment.name?.trim()
    if (!name) {
      continue
    }
    const hostId = toRuntimeExecutionHostId(environment.id)
    if (!labels.has(hostId)) {
      labels.set(hostId, name)
    }
  }
  return labels
}
