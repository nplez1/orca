import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { getEphemeralVmLifetimeLossError } from '../../shared/ephemeral-vm-recipes'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeSuspend,
  type EphemeralVmRecipeContext
} from '../../shared/ephemeral-vm-recipe-runner'
import { getProvisionedRootResumeIntegrityError } from './resume-integrity'
import { runControlledEphemeralVmRuntimeCleanup } from './runtime-cleanup-control'

export type CleanupEphemeralVmRuntimeArgs = {
  userDataPath: string
  repoPath: string
  recipe: OrcaVmRecipe
  runtimeId: string
  now?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type CleanupEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export type SuspendEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export type ResumeEphemeralVmRuntimeResult =
  | {
      ok: true
      runtime: EphemeralVmRuntimeRecord
      skipped: boolean
    }
  | {
      ok: false
      runtime: EphemeralVmRuntimeRecord
      error: string
    }

export function cleanupEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  return runControlledEphemeralVmRuntimeCleanup({
    userDataPath: args.userDataPath,
    runtimeId: args.runtimeId,
    signal: args.signal,
    run: (signal) => cleanupEphemeralVmRuntimeOnce({ ...args, signal })
  })
}

async function cleanupEphemeralVmRuntimeOnce(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<CleanupEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  if (existing.status === 'cleaned') {
    return {
      ok: true,
      runtime: existing,
      skipped: existing.cleanupStatus === 'disabled'
    }
  }

  const now = args.now ?? Date.now()
  const running = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'cleanup_pending',
    cleanupStatus: args.recipe.destroyDisabled ? 'disabled' : 'running',
    cleanupLastAttemptAt: now,
    cleanupLastError: null,
    updatedAt: now
  })
  const cleanup = await runEphemeralVmRecipeCleanup({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: contextFromRuntime(args.repoPath, running),
    recipeResult: running.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!cleanup.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: cleanup.error ?? 'Destroy failed.',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: cleanup.error ?? 'Destroy failed.' }
  }

  const cleaned = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'cleaned',
    cleanupStatus: cleanup.skipped ? 'disabled' : 'succeeded',
    cleanupLastError: null,
    updatedAt: Date.now()
  })
  return { ok: true, runtime: cleaned, skipped: cleanup.skipped }
}

export async function suspendEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<SuspendEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  const suspend = await runEphemeralVmRecipeSuspend({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: contextFromRuntime(args.repoPath, existing),
    recipeResult: existing.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!suspend.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'suspend_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: suspend.error ?? 'Suspend failed.' }
  }

  const suspended = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: suspend.skipped ? existing.status : 'suspended',
    updatedAt: Date.now()
  })
  return { ok: true, runtime: suspended, skipped: suspend.skipped }
}

export async function resumeEphemeralVmRuntime(
  args: CleanupEphemeralVmRuntimeArgs
): Promise<ResumeEphemeralVmRuntimeResult> {
  const existing = listEphemeralVmRuntimes(args.userDataPath).find(
    (entry) => entry.id === args.runtimeId
  )
  if (!existing) {
    throw new Error(`Unknown ephemeral VM runtime: ${args.runtimeId}`)
  }
  const resume = await runEphemeralVmRecipeResume({
    repoPath: args.repoPath,
    recipe: args.recipe,
    context: contextFromRuntime(args.repoPath, existing),
    recipeResult: existing.recipeResult,
    signal: args.signal,
    onStdout: args.onStdout,
    onStderr: args.onStderr
  })

  if (!resume.ok) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'resume_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: resume.error }
  }

  const resumeIntegrityError = resume.skipped
    ? null
    : getProvisionedRootResumeIntegrityError(existing.recipeResult, resume.result)
  if (resumeIntegrityError) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'resume_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: resumeIntegrityError }
  }

  // Why: an answer that loses the deadline would silently drop the countdown and the only
  // reconciliation this host has. The runtime is parked on resume_failed so the user sees it.
  const lostLifetimeError = resume.skipped
    ? null
    : getEphemeralVmLifetimeLossError(existing.recipeResult, resume.result, 'Resume')
  if (lostLifetimeError) {
    const failed = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
      status: 'resume_failed',
      updatedAt: Date.now()
    })
    return { ok: false, runtime: failed, error: lostLifetimeError }
  }

  const runtime = updateEphemeralVmRuntimeStatus(args.userDataPath, existing.id, {
    status: 'running',
    ...(!resume.skipped ? { recipeResult: resume.result } : {}),
    updatedAt: Date.now()
  })
  return { ok: true, runtime, skipped: resume.skipped }
}

export function contextFromRuntime(
  repoPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRecipeContext {
  return {
    instanceId: runtime.id,
    recipeId: runtime.recipeId,
    projectId: runtime.projectId,
    workspaceId: runtime.workspaceId,
    workspaceName: runtime.workspaceName,
    repoPath
  }
}
