import { RuntimeClientError } from '../../runtime-client'

const COMPATIBILITY_CLI_COMMANDS = [
  'orca',
  'orca-ide',
  'orca-dev',
  'orca-np',
  'orca-np-dev'
] as const

// Why: derived from the list so the accepted commands and the accepted type cannot drift apart.
type CompatibilityCliCommand = (typeof COMPATIBILITY_CLI_COMMANDS)[number]

// Why typed as a string set: the membership test then narrows in the guard below instead of
// forcing each caller to assert the value it just validated.
const COMPATIBILITY_CLI_COMMAND_SET: ReadonlySet<string> = new Set(COMPATIBILITY_CLI_COMMANDS)

function isCompatibilityCliCommand(value: string): value is CompatibilityCliCommand {
  return COMPATIBILITY_CLI_COMMAND_SET.has(value)
}

export function resolveCompatibilityCliCommand(): CompatibilityCliCommand {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured && isCompatibilityCliCommand(configured)) {
    return configured
  }
  return 'orca-np'
}

export function resolvePackagedWindowsCompatibilityCommand(): CompatibilityCliCommand | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command && isCompatibilityCliCommand(command)) {
    return command
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'The packaged Orca launcher did not provide a valid resume command. No question was created.'
  )
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
