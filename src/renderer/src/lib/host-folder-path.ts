import { isRuntimePathAbsolute } from '../../../shared/cross-platform-path'

/** The home shapes a host's own process expands: `~` and `~/…`, plus `~\…` on a Windows host.
 *  Deliberately duplicated from `workspace-dir-input.ts`'s private check so no `src/shared` file
 *  changes: every consumer here is renderer code. */
export function isHomePrefixedFolderPath(value: string, isWindowsHost: boolean): boolean {
  return value === '~' || value.startsWith('~/') || (isWindowsHost && value.startsWith('~\\'))
}

/** A folder a host can be handed: absolute as that host's own platform spells it, or a home path. */
export function isAbsoluteOrHomeFolderPath(value: string, isWindowsHost: boolean): boolean {
  return isRuntimePathAbsolute(value) || isHomePrefixedFolderPath(value, isWindowsHost)
}
