import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HOME_DIRECTORY_NAME,
  LEGACY_HOME_DIRECTORY_NAME
} from '../../../../shared/app-directory-names'
import { getWindowsNativeHookAgent } from './windows-native-hook-executable'
import { isOwnedManagedHookCommand, NATIVE_EXE_SUFFIX } from './managed-hook-command-ownership'
import { hasOfficialOrcaProfile } from '../../official-orca-profile'

import type { HookCommandConfig, HookDefinition } from '../configuration/hook-config-schema'
import { isPlainObject } from '../configuration/hooks-json-read'

const POSIX_SIMPLE_SHELL_EXECUTABLE = /^(?:\/bin\/sh|sh|bash|cmd|cmd\.exe)$/i
const CMD_EXECUTABLE = /^cmd(?:\.exe)?$/i
const POWERSHELL_EXECUTABLE = /(?:^|\/)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i

export type ManagedCommandMatcherOptions = {
  /**
   * Whether an entry under `LEGACY_HOME_DIRECTORY_NAME` may belong to this build. Defaults to the
   * host probe in {@link hasOfficialOrcaProfile}; injectable so a test never depends on the machine.
   */
  sweepLegacyHomeDirectory?: boolean
}

// Match only commands whose ownership by Orca is established, so user-maintained or composite
// commands that merely reference an Orca hook are never removed.
export function createManagedCommandMatcher(
  scriptFileName: string,
  options: ManagedCommandMatcherOptions = {}
): (command: unknown) => boolean {
  const scriptStem = scriptFileName.replace(/\.(?:cmd|ps1|sh)$/, '')
  // Sweep every platform suffix after a platform switch.
  const scriptNames = new Set([
    scriptFileName,
    `${scriptStem}.cmd`,
    `${scriptStem}.ps1`,
    `${scriptStem}.sh`
  ])
  const agentName = getWindowsNativeHookAgent(scriptFileName)
  const explicitLegacySweep = options.sweepLegacyHomeDirectory
  // hooks.json is user-editable, so a command may not be a string.
  return (command) =>
    typeof command === 'string' &&
    command.trim().length > 0 &&
    isOwnedManagedHookCommand(command, scriptNames, agentName) &&
    // Why the split: a resolved path under this user's own `~/.orca` may be an official install's,
    // while a remote host's or a frozen `${HOME}` template's `.orca` path may be this build's — the two
    // cannot be told apart from the command alone, so the remote forms are swept and the local one is not.
    // Read per call, not at construction: installing or removing the official app changes the answer.
    ((explicitLegacySweep ?? !hasOfficialOrcaProfile()) ||
      !namesLocalHomeDirectory(command, LEGACY_HOME_DIRECTORY_NAME) ||
      namesLocalHomeDirectory(command, HOME_DIRECTORY_NAME))
}

/**
 * Whether a command names this user's own home-directory child, which only a local install writes.
 *
 * Why resolved per call and not at construction: hook installs run during startup, and a host with no
 * usable home must lose the exclusion rather than fail to install hooks at all.
 */
function namesLocalHomeDirectory(command: string, directoryName: string): boolean {
  const home = homedir()
  if (typeof home !== 'string' || home.length === 0) {
    return false
  }
  const prefix = `${join(home, directoryName).replaceAll('\\', '/')}/`.toLowerCase()
  return command.replaceAll('\\', '/').toLowerCase().includes(prefix)
}

export function removeManagedCommands(
  definitions: HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): HookDefinition[] {
  return definitions.flatMap((definition) => {
    // hooks.json is user-editable, so an entry may not be an object; keep it untouched.
    if (!isPlainObject(definition)) {
      return [definition]
    }
    const directCommandKeys = ['command', 'bash', 'powershell'] as const
    const directManagedKeys = directCommandKeys.filter((key) => isManagedCommand(definition[key]))
    const hasNestedHooks = Array.isArray(definition.hooks)
    const hasManagedNestedHook =
      hasNestedHooks &&
      definition.hooks!.some((hook) => hookHasManagedCommand(hook, isManagedCommand))

    if (directManagedKeys.length === 0 && !hasManagedNestedHook) {
      return [definition]
    }

    const nextDefinition: HookDefinition = { ...definition }
    for (const key of directManagedKeys) {
      delete nextDefinition[key]
    }

    if (hasManagedNestedHook) {
      const filteredHooks = definition.hooks!.filter(
        (hook) => !hookHasManagedCommand(hook, isManagedCommand)
      )
      if (filteredHooks.length > 0) {
        nextDefinition.hooks = filteredHooks
      } else {
        delete nextDefinition.hooks
      }
    }

    const hasCommandAfterCleanup =
      directCommandKeys.some((key) => typeof nextDefinition[key] === 'string') ||
      (Array.isArray(nextDefinition.hooks) && nextDefinition.hooks.length > 0)
    if (!hasCommandAfterCleanup) {
      return []
    }

    return [nextDefinition]
  })
}

function hookHasManagedCommand(hook: HookCommandConfig, matches: (value?: string) => boolean) {
  if (!isPlainObject(hook) || typeof hook.command !== 'string') {
    return false
  }
  const args = Array.isArray(hook.args) ? hook.args : []
  if (args.length === 0) {
    return matches(hook.command)
  }
  if (!args.every((arg): arg is string => typeof arg === 'string')) {
    return false
  }
  const normalizedCommand = hook.command.trim().replaceAll('\\', '/')
  if (POSIX_SIMPLE_SHELL_EXECUTABLE.test(normalizedCommand)) {
    if (args.length === 1) {
      return matches(args[0])
    }
    const commandFlag = CMD_EXECUTABLE.test(normalizedCommand) ? '/c' : '-c'
    if (args.length === 2 && args[0] === commandFlag) {
      return matches(args[1])
    }
    if (commandFlag === '/c' && args.length === 3 && args[0] === '/d' && args[1] === '/c') {
      return matches(args[2])
    }
    return false
  }
  if (POWERSHELL_EXECUTABLE.test(normalizedCommand) || NATIVE_EXE_SUFFIX.test(normalizedCommand)) {
    // Joining is only faithful when each configured argument is a single token.
    return args.every((arg) => /^\S+$/.test(arg)) && matches(`${hook.command} ${args.join(' ')}`)
  }
  return false
}

// Users may opt a managed hook into async; keep that choice when the hook is rewritten.
export function withPreviousManagedAsync(
  hook: HookCommandConfig,
  definitions: HookDefinition[],
  matches: (command: string | undefined) => boolean
): HookCommandConfig {
  const async = definitions
    .flatMap((definition) => (Array.isArray(definition.hooks) ? definition.hooks : []))
    .find((prev) => typeof prev.async === 'boolean' && hookHasManagedCommand(prev, matches))?.async
  return async === undefined ? hook : { ...hook, async }
}

export function hookDefinitionHasManagedCommand(
  definition: HookDefinition,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  return (
    isPlainObject(definition) &&
    (isManagedCommand(definition.command) ||
      isManagedCommand(definition.bash) ||
      isManagedCommand(definition.powershell) ||
      (Array.isArray(definition.hooks) &&
        definition.hooks.some((hook) => hookHasManagedCommand(hook, isManagedCommand))))
  )
}
