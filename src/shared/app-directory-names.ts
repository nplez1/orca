/**
 * Directory names this build owns on disk.
 *
 * Why one module: the Electron app and the non-Electron processes (the CLI, orcad, the agent-hook
 * shell commands) each resolve these paths independently — the latter cannot import anything that
 * pulls Electron in — so a literal repeated across them is a rename waiting to half-happen. Every
 * reader imports from here instead.
 *
 * Why not upstream's `orca`/`Orca`/`.orca`: this fork is meant to sit beside an official Orca
 * install on the same machine. Sharing these names would let either install read, migrate, or
 * clobber the other's state.
 */

/** Electron's `appData` child: packaged userData lives here. */
export const APP_DATA_DIRECTORY_NAME = 'orca-np'

/** The dev/E2E sibling of `APP_DATA_DIRECTORY_NAME`. */
export const DEV_APP_DATA_DIRECTORY_NAME = 'orca-np-dev'

/** The home-directory child holding keybindings, provider credentials, and agent hooks. */
export const HOME_DIRECTORY_NAME = '.orca-np'
