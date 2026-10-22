/**
 * A delete whose host stopped answering must not strand the workspace.
 *
 * `worktree.rm` has to reach the Orca server inside the VM, so an unreachable host fails the delete
 * before the teardown that would have run the recipe's `destroy`: the workspace stays in the
 * sidebar AND its provider node stays allocated. Both halves are answered here — this module only
 * *decides* that Orca may drop the row, and the ordinary teardown then releases the machine in its
 * usual order. Deciding without acting is deliberate: the destroy must not run before the renderer
 * has shut its terminals down, and must not run at all until the archive-hook gate agrees.
 *
 * Why a fallback and not a preflight: the host is usually fine, and only the failure itself says
 * whether it answered.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { isRemoteRuntimeUnreachableMessage } from '../../../../../../shared/remote-runtime-client-error-classification'
import { isEphemeralVmRuntimeEnvironment } from '../../../../../../shared/runtime-environments'
import {
  ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX,
  ARCHIVE_HOOK_OVERRIDE_HINT
} from '../../../../../../shared/worktree/archive-hook-removal-gate'
import type { EphemeralVmCleanupSummary } from '@/lib/ephemeral-vm-runtime-cleanup'
import { listEphemeralVmRuntimesForWorkspace } from '@/lib/ephemeral-vm-runtime-cleanup'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'

export type UnreachableVmRemovalFallback =
  /** Not a machine Orca owns, not a "host did not answer" failure, or the archive gate refused. */
  | { kind: 'not-applicable' }
  /** Drop the row and finish the delete. */
  | { kind: 'forget-locally' }

/**
 * Why the phrase and not the error class: Electron IPC rejects with a plain Error, so the renderer
 * never sees `code`. Mirrors SSH_HOST_NOT_SERVED_MESSAGE / sshTargetNotConnectedMessage, which an
 * SSH-connection-mode VM's workspace delete answers with when nothing serves its target.
 */
const SSH_HOST_NOT_ANSWERING_FRAGMENTS = [
  'remote connection dropped',
  'not found or not connected'
] as const

function removalErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether this failure says the host stopped answering, in either transport's own words. */
function isHostNotAnswering(error: unknown): boolean {
  const message = removalErrorMessage(error)
  if (isRemoteRuntimeUnreachableMessage(message)) {
    return true
  }
  const lowered = message.toLowerCase()
  return SSH_HOST_NOT_ANSWERING_FRAGMENTS.some((fragment) => lowered.includes(fragment))
}

/**
 * What the renderer can prove about who owns the machine behind a host id, without IPC.
 *
 * `unknown` is a `runtime:` host whose environment this client does not hold (already removed, or
 * never hydrated) — the one case where the runtime records are the only witness.
 */
type HostOwnership = 'orca' | 'not-orca' | 'unknown'

function classifyHostOwnership(get: WorktreeSliceGet, hostId: ExecutionHostId): HostOwnership {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'ssh') {
    // Runtime-owned targets exist only because a recipe VM created them.
    return isRuntimeOwnedSshTargetId(parsed.targetId) ? 'orca' : 'not-orca'
  }
  if (parsed?.kind !== 'runtime') {
    return 'not-orca'
  }
  const environment = get().runtimeEnvironments.find((entry) => entry.id === parsed.environmentId)
  if (!environment) {
    return 'unknown'
  }
  // Why a known environment outranks the records: a server the user paired themselves is not
  // Orca's to destroy, whatever a leftover record says, and that mistake costs their machine.
  return isEphemeralVmRuntimeEnvironment(environment) ? 'orca' : 'not-orca'
}

/**
 * Whether Orca owns the machine behind this workspace.
 *
 * Why the records are consulted at all: they are the only witness left once the environment itself
 * is gone from this client — the one case the host id cannot classify.
 */
async function isOrcaOwnedWorkspace(args: {
  get: WorktreeSliceGet
  worktreeId: string
  hostId: ExecutionHostId
}): Promise<boolean> {
  const ownership = classifyHostOwnership(args.get, args.hostId)
  if (ownership !== 'unknown') {
    return ownership === 'orca'
  }
  try {
    const matched = await listEphemeralVmRuntimesForWorkspace({
      workspaceId: args.worktreeId,
      executionHostId: args.hostId
    })
    return matched.length > 0
  } catch (error) {
    // Why a failed peek answers no: the caller then keeps its connection failure, which is the
    // conservative outcome for a host whose ownership we cannot establish.
    console.warn('Could not list ephemeral VM runtimes for an unreachable workspace:', error)
    return false
  }
}

/**
 * Whether this repo's configuration would have run an archive hook.
 *
 * Why positive evidence and not `skipArchive`: with the host down, nothing on this side can say
 * whether orca.yaml declares a hook, so `skipArchive` reads "the check could not run" — which is not
 * a decision the user made. What can be known is what they approved: a repo-wide trust record, an
 * archive record approved by content hash, or a local script override. Any of those is a hook the
 * normal delete would have run, so it must be waived here.
 *
 * Known gap, and pre-existing: a hook orca.yaml declares but nobody has approved yet records
 * nothing, and with the host down its content cannot be fetched to ask — the same "skip" a delete
 * takes today, which this path does not make worse. Only the machine's remaining lease is at stake,
 * and its provider ends that on its own.
 */
function wouldRunArchiveHook(get: WorktreeSliceGet, repoId: string): boolean {
  const trust = get().trustedOrcaHooks[repoId]
  if (trust?.all || trust?.archive) {
    return true
  }
  const repo = get().repos.find((entry) => entry.id === repoId)
  return Boolean(repo?.hookSettings?.scripts?.archive?.trim())
}

/**
 * Refuse to skip a save step the user configured, exactly as a failed hook does.
 *
 * Why: the archive hook ships whatever work is on the checkout before Orca deletes it, and it runs
 * on the guest. A host that never answered has not run it, so destroying the machine here would
 * take the work the hook exists to save. Loss of contact is never evidence the hook passed.
 */
function archiveGateRefusal(worktreePath: string): string {
  return [
    `${ARCHIVE_HOOK_FAILED_REMOVAL_PREFIX} ${worktreePath} — outcome unverifiable (the host never answered, so the archive hook could not run).`,
    ARCHIVE_HOOK_OVERRIDE_HINT
  ].join(' ')
}

export function showUnreachableVmRemovalNotice(cleanup: EphemeralVmCleanupSummary): void {
  // Why keyed on what actually ran: a matched record that ran no destroy (already released,
  // reclaimed, in use by another workspace) never released a machine, so claiming it did is a lie.
  if (cleanup.releasedRuntimeIds.length === 0) {
    toast.info(
      translate(
        'auto.store.slices.worktree.removal.vmNotReleasedTitle',
        'Workspace removed — its VM may still be running'
      ),
      {
        description: translate(
          'auto.store.slices.worktree.removal.vmNotReleasedBody',
          'Its server never answered, so Orca removed the workspace locally and left the machine to its provider lease. Settings → Ephemeral VMs shows it while it is still running.'
        )
      }
    )
    return
  }
  toast.info(
    translate(
      'auto.store.slices.worktree.removal.vmReleasedTitle',
      'Workspace removed — its VM was released'
    ),
    {
      description: translate(
        'auto.store.slices.worktree.removal.vmReleasedBody',
        'Its server never answered, so Orca released the machine without it instead of leaving it allocated.'
      )
    }
  )
}

/**
 * Resolve whether an unreachable host's workspace may be dropped here.
 *
 * Answers `not-applicable` for a host Orca does not own (a paired server, an SSH target the user
 * configured): its machine may still come back with their work, so the original error stands.
 *
 * Throws the archive-hook refusal when the delete would have run a hook: the retry that waives it
 * ("Delete Anyway") reaches this fallback again with `allowFailedArchiveHook`, so the user is never
 * stuck — it costs one click, and only in a repo that has a hook to run.
 */
export async function resolveUnreachableVmRemovalFallback(args: {
  error: unknown
  worktreeId: string
  worktreePath: string
  /** Host id the removal was routed at; without it a match could name another host's machine. */
  hostId: ExecutionHostId | undefined
  repoId: string
  allowFailedArchiveHook: boolean
  get: WorktreeSliceGet
}): Promise<UnreachableVmRemovalFallback> {
  if (!args.hostId || !isHostNotAnswering(args.error)) {
    return { kind: 'not-applicable' }
  }
  const orcaOwned = await isOrcaOwnedWorkspace({
    get: args.get,
    worktreeId: args.worktreeId,
    hostId: args.hostId
  })
  if (!orcaOwned) {
    return { kind: 'not-applicable' }
  }
  if (!args.allowFailedArchiveHook && wouldRunArchiveHook(args.get, args.repoId)) {
    throw new Error(archiveGateRefusal(args.worktreePath))
  }
  return { kind: 'forget-locally' }
}
