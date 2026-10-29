import {
  isCompatibilityCliCommand,
  isCompatibilityWindowsCommand,
  type CompatibilityCliCommand,
  type CompatibilityWindowsCommand
} from '../../../shared/orchestration-compatibility-cli-commands'
import { RuntimeClientError } from '../../runtime-client'

export function resolveCompatibilityCliCommand(): CompatibilityCliCommand {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured && isCompatibilityCliCommand(configured)) {
    return configured
  }
  return 'orca-np'
}

export function resolvePackagedWindowsCompatibilityCommand():
  | CompatibilityWindowsCommand
  | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command && isCompatibilityWindowsCommand(command)) {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
}

/** Params for one retry without the peer-CLI names, when the peer refused them.
 *
 *  A host built before the Orca NP rename — and upstream Orca — validates these against the
 *  closed set `orca | orca-ide | orca-dev`, so a call carrying `orca-np` comes back as invalid
 *  params and the whole check or ask fails. The param schema is validated before any handler
 *  runs, so the same call without the fields is the answer those hosts do accept; retrying it
 *  degrades the resume command they render to their own default instead of losing the call.
 *
 *  Only `invalid_argument` qualifies, and only when the request carried one of the fields: a
 *  failure the handler raised itself repeats, and this returns null so the caller rethrows it. */
export function compatibilityCommandFallbackParams(
  error: unknown,
  params: unknown
): Record<string, unknown> | null {
  if (!(error instanceof RuntimeClientError) || error.code !== 'invalid_argument') {
    return null
  }
  if (!isRecord(params)) {
    return null
  }
  if (!('compatibilityCliCommand' in params) && !('compatibilityWindowsCommand' in params)) {
    return null
  }
  const { compatibilityCliCommand: _cli, compatibilityWindowsCommand: _windows, ...rest } = params
  void _cli
  void _windows
  return rest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function flushOrchestrationStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write('', (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export function isDevCliInvocation(): boolean {
  return (
    process.env.ORCA_DEV_CLI_INVOCATION === '1' ||
    (process.env.ORCA_USER_DATA_PATH?.includes('orca-np-dev') ?? false)
  )
}
