import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import {
  getEphemeralVmRecipeResultProjectRoot,
  type EphemeralVmRecipeDoctorCheck,
  type EphemeralVmRecipeResult
} from '../../shared/ephemeral-vm-recipes'
import { getEphemeralVmRecipeResultWarnings } from '../../shared/ephemeral-vm-recipe-diagnostics'
// Why: import directly from the doctor module (not the barrel) — it uses Node
// fs/path and must stay out of the browser bundle that imports the barrel.
import { doctorEphemeralVmRecipe } from '../../shared/ephemeral-vm-recipe-doctor'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeStart,
  type EphemeralVmRecipeContext
} from '../../shared/ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  extendEphemeralVmRecipeFromFile,
  formatExtendEphemeralVmRecipeResult
} from '../vm-recipe-extend'
import {
  buildProvisionFailureRemediation,
  capTranscriptStream,
  formatDoctorResult,
  type DoctorResult,
  type ProvisionStageTranscript,
  type ProvisionTranscript
} from '../vm-recipe-doctor-format'

export const VM_HANDLERS: Record<string, CommandHandler> = {
  'vm recipe extend': async ({ flags, cwd, json }) => {
    const recipeId = getStringFlag(flags, 'recipe-id')
    if (!recipeId) {
      throw new RuntimeClientError('invalid_argument', 'Missing recipe id.')
    }
    const recipeResultPath = getStringFlag(flags, 'recipe-result')
    if (!recipeResultPath) {
      throw new RuntimeClientError('invalid_argument', 'Missing --recipe-result.')
    }
    const requestedLifetime = getStringFlag(flags, 'lifetime')
    if (!requestedLifetime) {
      throw new RuntimeClientError('invalid_argument', 'Missing --lifetime.')
    }
    // Why parsed here rather than in the runner: a non-numeric value is an argument error, and the
    // command must not start a hook it cannot bound.
    const timeoutFlag = getStringFlag(flags, 'timeout-ms')
    const timeoutMs = timeoutFlag === null ? undefined : Number(timeoutFlag)
    const repoPath = getStringFlag(flags, 'repo-path') ?? cwd
    const recipe = loadRecipe(repoPath, recipeId)
    const result = recipe
      ? await extendEphemeralVmRecipeFromFile({
          repoPath,
          recipe,
          recipeResultPath: resolve(cwd, recipeResultPath),
          requestedLifetime,
          ...(timeoutMs === undefined ? {} : { timeoutMs })
        })
      : {
          recipeId,
          repoPath,
          ok: false as const,
          error: `Recipe "${recipeId}" was not found in environmentRecipes.`
        }
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatExtendEphemeralVmRecipeResult(result))
    }
    if (!result.ok) {
      process.exitCode = 1
    }
  },
  'vm recipe doctor': async ({ flags, cwd, json }) => {
    const recipeId = getStringFlag(flags, 'recipe-id')
    if (!recipeId) {
      throw new RuntimeClientError('invalid_argument', 'Missing recipe id.')
    }
    const repoPath = getStringFlag(flags, 'repo-path') ?? cwd
    const shouldProvision = flags.get('provision') === true || flags.get('connect') === true
    const result = shouldProvision
      ? await doctorRecipeWithProvision(repoPath, recipeId)
      : doctorRecipe(repoPath, recipeId)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatDoctorResult(result))
    }
    if (!result.ok) {
      process.exitCode = 1
    }
  }
}

function doctorRecipe(repoPath: string, recipeId: string): DoctorResult {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (!existsSync(yamlPath)) {
    return {
      recipeId,
      repoPath,
      ok: false,
      checks: [
        {
          id: 'orca_yaml.exists',
          status: 'fail',
          message: `No orca.yaml found at ${yamlPath}`,
          remediation: 'Add environmentRecipes to the repo orca.yaml.'
        }
      ]
    }
  }

  const hooks = parseOrcaYaml(readTextFile(yamlPath))
  const parseCheck: EphemeralVmRecipeDoctorCheck = {
    id: 'orca_yaml.parse',
    status: hooks ? 'pass' : 'fail',
    message: hooks ? 'orca.yaml parsed successfully.' : 'orca.yaml has no supported Orca config.',
    ...(hooks ? {} : { remediation: 'Add an environmentRecipes entry to orca.yaml.' })
  }
  const result = doctorEphemeralVmRecipe({
    repoPath,
    recipeId,
    recipes: hooks?.environmentRecipes ?? [],
    localExecutionSupported: true
  })
  return {
    ...result,
    ok: parseCheck.status !== 'fail' && result.ok,
    checks: [parseCheck, ...result.checks]
  }
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8')
}

// Why: give the agent the full create/destroy output so it can self-diagnose a
// failed provision instead of relaying logs through the user. Each stream is
// redacted and capped (head+tail) so a huge log stays readable but complete enough.
async function doctorRecipeWithProvision(
  repoPath: string,
  recipeId: string
): Promise<DoctorResult> {
  const baseline = doctorRecipe(repoPath, recipeId)
  if (!baseline.ok) {
    return {
      ...baseline,
      checks: [
        ...baseline.checks,
        {
          id: 'recipe.provision.skipped',
          status: 'fail',
          message: 'Provisioning was skipped because non-destructive doctor checks failed.',
          remediation: 'Fix the failing checks before running --provision again.'
        }
      ]
    }
  }

  const recipe = loadRecipe(repoPath, recipeId)
  if (!recipe) {
    return baseline
  }

  const start = await runEphemeralVmRecipeStart({ repoPath, recipe })
  if (!start.ok) {
    const provisionTranscript: ProvisionTranscript = {
      provision: {
        exitCode: start.exitCode,
        signal: start.signal,
        stdout: capTranscriptStream(start.stdout),
        stderr: capTranscriptStream(start.stderr),
        parseError: start.error
      }
    }
    const checks: EphemeralVmRecipeDoctorCheck[] = [
      ...baseline.checks,
      {
        id: 'recipe.provision',
        status: 'fail',
        message: start.error,
        // Why the extra sentence: a create that returned a result it could not be used with has
        // already allocated the machine, so the report has to say that one exists.
        remediation: start.recipeResult
          ? `${buildProvisionFailureRemediation(start.stderr, start.stdout)} A machine was created; the destroy action below is what released it.`
          : buildProvisionFailureRemediation(start.stderr, start.stdout)
      }
    ]
    // Why cleanup on this path too: `recipeResult` present means the machine exists. Returning without
    // destroy left it running with nobody holding its resource id, which is what made a checkout-mode
    // mismatch a paid-for leak rather than a failed self-test.
    if (start.recipeResult) {
      const cleanup = await runDoctorCleanup({
        repoPath,
        recipe,
        context: start.context,
        recipeResult: start.recipeResult
      })
      checks.push(cleanup.check)
      if (cleanup.stage) {
        provisionTranscript.destroy = cleanup.stage
      }
    }
    return { ...baseline, ok: false, checks, provisionTranscript }
  }

  const checks: EphemeralVmRecipeDoctorCheck[] = [
    ...baseline.checks,
    {
      id: 'recipe.provision',
      status: 'pass',
      message: 'Recipe ran successfully and produced a valid VM recipe result.'
    },
    {
      id: 'recipe.result.project_root',
      status: 'pass',
      message: `Recipe returned projectRoot: ${getEphemeralVmRecipeResultProjectRoot(start.result)}`
    }
  ]
  for (const warning of getEphemeralVmRecipeResultWarnings(start.result)) {
    checks.push({
      id: warning.id,
      status: 'warn',
      message: warning.message,
      ...(warning.remediation ? { remediation: warning.remediation } : {})
    })
  }

  const cleanup = await runDoctorCleanup({
    repoPath,
    recipe,
    context: start.context,
    recipeResult: start.result
  })
  checks.push(cleanup.check)

  // Retain both stages for diagnosis even when creation succeeds and teardown fails.
  const provisionTranscript: ProvisionTranscript = {
    provision: {
      exitCode: 0,
      signal: null,
      stdout: capTranscriptStream(start.stdout),
      stderr: capTranscriptStream(start.stderr)
    },
    ...(cleanup.stage ? { destroy: cleanup.stage } : {})
  }

  return {
    ...baseline,
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    provisionTranscript
  }
}

function loadRecipe(repoPath: string, recipeId: string): OrcaVmRecipe | null {
  const hooks = parseOrcaYaml(readTextFile(join(repoPath, 'orca.yaml')))
  return hooks?.environmentRecipes?.find((entry) => entry.id === recipeId) ?? null
}

/**
 * Run the destroy hook for a machine a doctor provisioning run created, and report it as a check.
 *
 * Why shared by both paths: a create that reports a problem may still have allocated the machine, so
 * the two outcomes need the same teardown and the same words about what is left running.
 */
async function runDoctorCleanup(args: {
  repoPath: string
  recipe: OrcaVmRecipe
  context: EphemeralVmRecipeContext
  recipeResult: EphemeralVmRecipeResult
}): Promise<{ check: EphemeralVmRecipeDoctorCheck; stage: ProvisionStageTranscript | null }> {
  const cleanup = await runEphemeralVmRecipeCleanup(args)
  if (cleanup.skipped) {
    return {
      check: {
        id: 'recipe.destroy.run',
        status: 'warn',
        message: 'Destroy was skipped because destroy is disabled or missing.',
        remediation: 'Destroy any provider resources created by the doctor run manually.'
      },
      stage: null
    }
  }
  const stage: ProvisionStageTranscript = {
    exitCode: cleanup.exitCode,
    signal: cleanup.signal,
    stdout: capTranscriptStream(cleanup.stdout),
    stderr: capTranscriptStream(cleanup.stderr)
  }
  return {
    check: cleanup.ok
      ? {
          id: 'recipe.destroy.run',
          status: 'pass',
          message: 'Destroy action ran successfully after provisioning.'
        }
      : {
          id: 'recipe.destroy.run',
          status: 'fail',
          message: cleanup.error ?? 'Destroy action failed after provisioning.',
          remediation: 'Destroy provider resources manually, then fix the destroy action.'
        },
    stage
  }
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : null
}
