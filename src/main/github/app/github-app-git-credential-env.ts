// git acting as the bound GitHub App. The token is minted when git asks for one, not when the session
// starts, because an installation token lives an hour and a worktree can outlive it. No token reaches
// argv or the environment: git runs the credential helper, and the helper asks Orca for a fresh one.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { quotePosixShellUnlessPlain } from '../../../shared/shell/launch/shell-argument-quoting'
import { getOrcaCliCommandNameForPlatform } from '../../../shared/cli/orca-cli-command-name'
import { GITHUB_APP_HOST } from './github-app-bound-token'

/** The `orca` a child runs the helper with: the launcher when the app knows one, else the command name. */
function orcaCommand(env: NodeJS.ProcessEnv): string {
  const launcher = env.ORCA_CLI_COMMAND?.trim()
  return launcher || getOrcaCliCommandNameForPlatform(process.platform)
}

/** `!orca git-credential --repo <folder>`: git's shell form, so the helper gets `get`/`store`/`erase`. */
export function appGitCredentialHelper(
  repoFolder: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return `!${quotePosixShellUnlessPlain(orcaCommand(env))} git-credential --repo ${quotePosixShellUnlessPlain(repoFolder)}`
}

/** The remotes this rewrites: an SSH push would otherwise use the user's key, which is not the App. */
const APP_SSH_REMOTE_PREFIXES = [`git@${GITHUB_APP_HOST}:`, `ssh://git@${GITHUB_APP_HOST}/`]

type GitConfigEntry = [key: string, value: string]

/** Emptying `credential.helper` first is what stops a configured helper answering before Orca's. */
export function appGitConfigEntries(
  repoFolder: string,
  env: NodeJS.ProcessEnv = process.env
): GitConfigEntry[] {
  const url = `https://${GITHUB_APP_HOST}/`
  return [
    ['credential.helper', ''],
    ['credential.helper', appGitCredentialHelper(repoFolder, env)],
    ...APP_SSH_REMOTE_PREFIXES.map((prefix): GitConfigEntry => [`url.${url}.insteadOf`, prefix])
  ]
}

/** `env` with git's indexed-config protocol carrying the App's credential and URL rewrite. */
export function appBoundGitEnv(input: {
  repoFolder: string
  baseEnv?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const env = input.baseEnv ?? process.env
  const next = { ...env }
  // A caller's own indexed config cannot be merged with this one: git reads one count, and ours has to be it.
  for (const key of Object.keys(next)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) {
      delete next[key]
    }
  }
  const entries = appGitConfigEntries(input.repoFolder, env)
  next.GIT_CONFIG_COUNT = String(entries.length)
  entries.forEach(([key, value], index) => {
    next[`GIT_CONFIG_KEY_${index}`] = key
    next[`GIT_CONFIG_VALUE_${index}`] = value
  })
  next.GIT_TERMINAL_PROMPT = '0'
  return next
}

/** The App's git config as a file, for a session whose own environment may lose `GIT_CONFIG_KEY_n` names. */
export function appGitConfigFile(input: {
  repoFolder: string
  baseEnv?: NodeJS.ProcessEnv
}): string {
  const env = input.baseEnv ?? process.env
  const globalConfigs = gitGlobalConfigCandidates(env)
  return [
    `# Orca: git acts as the GitHub App bound to ${input.repoFolder}`,
    '# The token is minted when git asks for one, never stored here.',
    ...(globalConfigs.length > 0
      ? ['[include]', ...globalConfigs.map((p) => `\tpath = ${p}`)]
      : []),
    '[credential]',
    '\thelper =',
    `\thelper = ${configFileQuoted(appGitCredentialHelper(input.repoFolder, env))}`,
    `[url "https://${GITHUB_APP_HOST}/"]`,
    ...APP_SSH_REMOTE_PREFIXES.map((prefix) => `\tinsteadOf = ${prefix}`),
    ''
  ].join('\n')
}

/**
 * The global config files git would have read, so replacing them through `GIT_CONFIG_GLOBAL` does not
 * quietly drop the user's own settings. `GIT_CONFIG_GLOBAL` may be set to `NUL`/`/dev/null` to disable them.
 */
function gitGlobalConfigCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.GIT_CONFIG_GLOBAL?.trim()
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  if (explicit) {
    return /^(?:\/dev\/null|nul)$/i.test(explicit) ? [] : [toGitConfigPath(explicit)]
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return [join(xdg, 'git', 'config'), join(home, '.gitconfig')].map(toGitConfigPath)
}

function toGitConfigPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/** A config-file value: double-quoted, with the escapes git's own reader understands. */
function configFileQuoted(value: string): string {
  return `"${toGitConfigPath(value).replace(/"/g, '\\"')}"`
}
