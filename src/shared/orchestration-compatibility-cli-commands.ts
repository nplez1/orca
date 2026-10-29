/** The CLI names a peer host may be told to render its resume commands with.
 *
 *  A host built before the Orca NP rename validates this against a closed set, and any
 *  value outside it fails the whole call as invalid params. Adding a name is therefore a
 *  compatible change only for hosts that know it — see
 *  `compatibilityCommandFallbackParams` for what a caller does when a host refuses one. */
export const COMPATIBILITY_CLI_COMMANDS = [
  'orca',
  'orca-ide',
  'orca-dev',
  'orca-np',
  'orca-np-dev'
] as const

export type CompatibilityCliCommand = (typeof COMPATIBILITY_CLI_COMMANDS)[number]

/** The packaged Windows launcher's own names: it never identifies as `orca-dev`. */
export const COMPATIBILITY_WINDOWS_COMMANDS = [
  'orca',
  'orca-ide',
  'orca-np',
  'orca-np-dev'
] as const

export type CompatibilityWindowsCommand = (typeof COMPATIBILITY_WINDOWS_COMMANDS)[number]

export function isCompatibilityCliCommand(value: string): value is CompatibilityCliCommand {
  return COMPATIBILITY_CLI_COMMANDS.some((command) => command === value)
}

export function isCompatibilityWindowsCommand(value: string): value is CompatibilityWindowsCommand {
  return COMPATIBILITY_WINDOWS_COMMANDS.some((command) => command === value)
}
