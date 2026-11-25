import { createHash } from 'node:crypto'
import type { AutomationScriptStep } from '../../../shared/automations/steps/automation-steps'

/** The digest of the raw file bytes, recorded on each run for incident review. */
export function automationScriptContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * What an approval pins: the path, the arguments and the exact bytes, so re-pointing an approved
 * `run.sh "$@"` with new arguments needs approval again. Never normalised, so a dropped shebang differs.
 */
export function automationScriptStepPin(
  step: Pick<AutomationScriptStep, 'script' | 'args'>,
  bytes: Uint8Array
): string {
  return createHash('sha256')
    .update(JSON.stringify([step.script, step.args ?? []]))
    .update('\0')
    .update(bytes)
    .digest('hex')
}
