import { RuntimeClientError } from '../../runtime-client'

type CompatibilityCliCommand = 'orca' | 'orca-ide' | 'orca-dev' | 'orca-np' | 'orca-np-dev'

const COMPATIBILITY_CLI_COMMANDS: readonly string[] = [
  'orca',
  'orca-ide',
  'orca-dev',
  'orca-np',
  'orca-np-dev'
]

export function resolveCompatibilityCliCommand(): CompatibilityCliCommand {
  const configured = process.env.ORCA_CLI_COMMAND
  if (configured && COMPATIBILITY_CLI_COMMANDS.includes(configured)) {
    return configured as CompatibilityCliCommand
  }
  return 'orca-np'
}

export function resolvePackagedWindowsCompatibilityCommand(): CompatibilityCliCommand | undefined {
  if (process.env.ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER !== '1') {
    return undefined
  }
  const command = process.env.ORCA_CLI_COMMAND
  if (command && COMPATIBILITY_CLI_COMMANDS.includes(command)) {
    return command as CompatibilityCliCommand
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
