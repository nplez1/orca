import { parseAutomationSteps, type AutomationStep } from '../../shared/automation-steps'
import { RuntimeClientError } from '../runtime-client'

/**
 * The plan flag, as JSON, because the commands in it are multi-line shell and the
 * only expected author is an agent. Ordered repeatable flags would put ordering and
 * quoting between the author and the executor for no gain.
 *
 * `--steps-json` and `--prompt`/`--provider` are mutually exclusive: a plan already
 * says whether it ends in an agent step, so accepting both would leave two answers
 * to one question.
 */
export function getStepsFlag(flags: Map<string, string | boolean>): AutomationStep[] | undefined {
  if (!flags.has('steps-json')) {
    return undefined
  }
  const raw = flags.get('steps-json')
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--steps-json requires a JSON array of steps, for example \'[{"kind":"script","command":"pnpm build"}]\''
    )
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--steps-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const parsed = parseAutomationSteps(value)
  if (!parsed.ok) {
    throw new RuntimeClientError('invalid_argument', `--steps-json is invalid: ${parsed.error}`)
  }
  return parsed.steps
}

/** Refuses a request that names its plan twice, before the runtime is touched. */
export function assertSinglePlanSource(
  flags: Map<string, string | boolean>,
  steps: AutomationStep[] | undefined
): void {
  if (!steps) {
    return
  }
  if (flags.has('prompt') || flags.has('provider')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --steps-json or --prompt/--provider, not both: a plan already carries its agent step.'
    )
  }
}
