import type { AutomationAction } from '../../shared/automations/automation-definition'
import {
  DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS,
  MAX_AUTOMATION_COMMAND_LENGTH,
  MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS,
  normalizeAutomationScript
} from '../../shared/automations/launch/automation-command'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'

/** `--script` makes the automation a command; its companions default rather than being required. */
export function getScriptActionFlag(
  flags: Map<string, string | boolean>
): AutomationAction | null | undefined {
  const companions = ['script-timeout', 'script-shell', 'report'].filter((name) => flags.has(name))
  if (!flags.has('script')) {
    if (companions.length > 0) {
      throw new RuntimeClientError('invalid_argument', `--${companions[0]} requires --script`)
    }
    return undefined
  }
  const value = flags.get('script')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', '--script requires a command')
  }
  // An empty --script turns a command automation back into an agent one.
  if (!value.trim()) {
    return null
  }
  if (flags.has('precheck')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --script or --precheck, not both: a precheck only gates an agent run.'
    )
  }
  const timeoutSeconds = getOptionalPositiveIntegerFlag(flags, 'script-timeout')
  if (timeoutSeconds !== undefined && timeoutSeconds > MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--script-timeout is at most ${MAX_AUTOMATION_COMMAND_TIMEOUT_SECONDS} seconds`
    )
  }
  const shell = getOptionalStringFlag(flags, 'script-shell')
  if (shell !== undefined && shell !== 'login' && shell !== 'plain') {
    throw new RuntimeClientError('invalid_argument', '--script-shell is login or plain')
  }
  const report = getOptionalStringFlag(flags, 'report')
  if (
    report !== undefined &&
    report !== 'silent' &&
    report !== 'on-output' &&
    report !== 'always'
  ) {
    throw new RuntimeClientError('invalid_argument', '--report is silent, on-output or always')
  }
  const script = normalizeAutomationScript({
    command: value,
    timeoutSeconds: timeoutSeconds ?? DEFAULT_AUTOMATION_COMMAND_TIMEOUT_SECONDS,
    shell: shell ?? 'login',
    report: report ?? 'on-output'
  })
  if (!script) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--script is a command of at most ${MAX_AUTOMATION_COMMAND_LENGTH} characters`
    )
  }
  return { kind: 'command', script }
}
