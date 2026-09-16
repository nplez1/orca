/**
 * The installed command name. Deliberately not the bundled launcher's file name (see
 * bundled-cli-launcher-path.ts): the launcher lives inside the app bundle, while this is what lands
 * in a PATH directory — and it has to differ from `orca`, which an official Orca install claims.
 */
export const CLI_COMMAND_NAME = 'orca-np'
export const DEFAULT_MAC_COMMAND_PATH = `/usr/local/bin/${CLI_COMMAND_NAME}`
export const DEV_COMMAND_NAME = 'orca-np-dev'
export const LEGACY_LINUX_COMMAND_NAME = 'orca'
export const DEV_LAUNCHER_DIR = ['cli', 'bin'] as const
export const WINDOWS_PATH_WRITE_TIMEOUT_MS = 5_000
