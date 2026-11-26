import { HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME } from '../../../app-directory-names'

/** Orca's Claude status hooks as a plugin folder, for a Claude whose config folder Orca never hooked. */
export const CLAUDE_HOOK_PLUGIN_DIR_ENV = 'ORCA_CLAUDE_HOOK_PLUGIN_DIR'

export const CLAUDE_HOOK_PLUGIN_NAME = 'orca-status-hooks'

// Base64 of the fixed `$ProgressPreference='SilentlyContinue'; ` lead every Orca -EncodedCommand hook starts with.
const ORCA_ENCODED_HOOK_LEAD =
  'JABQAHIAbwBnAHIAZQBzAHMAUAByAGUAZgBlAHIAZQBuAGMAZQA9ACcAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAnADsA'

// Why derived from the shared names and not `.orca`: this build's home child is `.orca-np`, a
// character longer, so a pattern pinned to the official name misses the runtime-home command this
// build itself writes. Both names are kept so one settings file may hold either install's hooks.
const HOME_DIRECTORY_PATTERN = [HOME_DIRECTORY_NAME, LEGACY_HOME_DIRECTORY_NAME]
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

/** Matches any Orca-managed hook command in a settings file: script paths with either separator (JSON-escaped), the native .exe, encoded PowerShell. */
// Why a plain group and not `(?:…)`: this string is also run through `grep -sE` by the bash/zsh
// `claude` wrapper (claude-shell-function.ts), which rejects `(?:` outright — silently under -s, so the
// guard would read "no Orca hooks" and add them a second time.
export const CLAUDE_MANAGED_HOOK_COMMAND_PATTERN = String.raw`(${HOME_DIRECTORY_PATTERN}).{1,2}agent-hooks|orca-agent-hook\.exe|-EncodedCommand ${ORCA_ENCODED_HOOK_LEAD}`
