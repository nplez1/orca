import { z } from 'zod'
import {
  EphemeralVmRecipeConnectionResultSchema,
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeResultSchema
} from './ephemeral-vm-recipes'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'

export const EphemeralVmRuntimeStatusSchema = z.enum([
  'provisioning',
  'running',
  'suspended',
  'suspend_failed',
  'resume_failed',
  'failed',
  'cleanup_pending',
  'cleanup_failed',
  'cleaned'
])

export type EphemeralVmRuntimeStatus = z.infer<typeof EphemeralVmRuntimeStatusSchema>

export const EphemeralVmCleanupStatusSchema = z.enum([
  'not_started',
  'disabled',
  'running',
  'succeeded',
  'failed'
])

export type EphemeralVmCleanupStatus = z.infer<typeof EphemeralVmCleanupStatusSchema>

export const EphemeralVmRuntimeConnectionModeSchema = z.enum(['orca-server', 'ssh'])

const EphemeralVmRuntimeRecipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    create: z.string().min(1),
    checkoutMode: z.enum(['orca-worktree', 'provisioned-root']).optional(),
    description: z.string().min(1).optional(),
    suspend: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    destroy: z.string().min(1).optional(),
    destroyDisabled: z.boolean().optional()
  })
  .strict()

export const EphemeralVmRuntimeRecordSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  /** Immutable lifecycle commands used for this runtime even if its source
   * pack is updated, disabled, or removed later. */
  recipe: EphemeralVmRuntimeRecipeSchema.optional(),
  /**
   * The provider's lease-extension verb, snapshotted with the lifecycle commands so that a later
   * `orca.yaml` edit cannot redirect it at a lease that is already running. Declared here rather
   * than inside `recipe` because that snapshot is strict and the store file is written in a shape
   * an older build has to keep reading; this object is not strict, so an older build strips and
   * ignores these fields rather than losing the whole runtime.
   */
  extend: z.string().min(1).optional(),
  /** The lifetimes the provider will sell for this host, already canonicalized when `orca.yaml`
   *  was parsed. Orca offers only these, so it can never ask for a lease that would be refused. */
  extendDurations: z.array(z.string().min(1)).optional(),
  repoId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  connectionMode: EphemeralVmRuntimeConnectionModeSchema.optional(),
  runtimeEnvironmentId: z.string().min(1).optional(),
  sshTargetId: z.string().min(1).optional(),
  status: EphemeralVmRuntimeStatusSchema,
  cleanupStatus: EphemeralVmCleanupStatusSchema,
  cleanupDisabled: z.boolean().optional(),
  cleanupLastAttemptAt: z.number().finite().optional(),
  cleanupLastError: z.string().min(1).optional(),
  /**
   * When Orca released this host's registrations and forgot its workspace rows, because the
   * provider's lease had lapsed and the machine was not coming back.
   *
   * Why recorded rather than left to `status`: reclamation deliberately does NOT destroy the
   * provider resource — the provider's own TTL owns it, and destroying a machine that was extended
   * out of band would take unpushed work with it. So `status` cannot say "released", and this
   * instant is what makes the reclaim idempotent and the Settings row honest.
   */
  reclaimedAt: z.number().finite().optional(),
  /**
   * The execution-host identities this runtime was reachable as when it was reclaimed.
   *
   * Why persisted: the reclaim clears `sshTargetId` and `runtimeEnvironmentId` on this record, so
   * afterwards an SSH-only host could no longer be matched to its workspace row — and the renderer
   * needs that match to forget the row when the reclaim event reached nobody.
   */
  reclaimedHostIds: z.array(z.string().min(1)).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  recipeResult: EphemeralVmRecipeResultSchema
})

export type EphemeralVmRuntimeRecord = z.infer<typeof EphemeralVmRuntimeRecordSchema>

/**
 * The recipe as a runtime's snapshot stores it: only the commands the lifecycle actions run.
 *
 * Why the extend fields are dropped: that snapshot schema is strict and deliberately does not know
 * them — they live on the record itself, so the snapshot stays parseable by an older build. Leaving
 * them in makes the snapshot unparseable here, which fails the write *after* the provider has already
 * billed for a machine, so no caller may bypass this conversion.
 */
export function toEphemeralVmRuntimeRecipeSnapshot(
  recipe: OrcaVmRecipe
): NonNullable<EphemeralVmRuntimeRecord['recipe']> {
  const { extend: _extend, extendDurations: _extendDurations, ...snapshot } = recipe
  return snapshot
}

/** The lease-extension fields a recipe contributes to a runtime record, alongside the snapshot. */
export function toEphemeralVmRuntimeExtendFields(
  recipe: OrcaVmRecipe
): Pick<EphemeralVmRuntimeRecord, 'extend' | 'extendDurations'> {
  return {
    ...(recipe.extend ? { extend: recipe.extend } : {}),
    ...(recipe.extendDurations?.length ? { extendDurations: recipe.extendDurations } : {})
  }
}

export const EphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(EphemeralVmRuntimeRecordSchema)
})

export type EphemeralVmRuntimeStore = z.infer<typeof EphemeralVmRuntimeStoreSchema>

const RollbackEphemeralVmRuntimeRecipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    create: z.string().min(1),
    description: z.string().min(1).optional(),
    suspend: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    destroy: z.string().min(1).optional(),
    destroyDisabled: z.boolean().optional()
  })
  .strict()

export const RollbackEphemeralVmRuntimeRecordSchema = EphemeralVmRuntimeRecordSchema.extend({
  recipe: RollbackEphemeralVmRuntimeRecipeSchema.optional(),
  recipeResult: z.union([
    EphemeralVmRecipeLegacyResultSchema,
    EphemeralVmRecipeConnectionResultSchema
  ])
})

export const RollbackEphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(RollbackEphemeralVmRuntimeRecordSchema)
})
