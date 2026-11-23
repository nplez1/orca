// A repository bound to the App gets its bound identity in git too: Orca's own pushes and a bot's terminal
// both reach GitHub as `slug[bot]`. A repository bound to a user keeps the ambient git login untouched.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import {
  isAppGhAccountBinding,
  type GhAccountBinding
} from '../../../shared/github/accounts/account-binding'
import { createGhBoundAccountUnavailableError } from '../accounts/gh-bound-account-errors'
import { botsRootFolder } from '../../bots/bot-home'
import { hasAppEnvironment, getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'
import { readGithubAppCredentials } from './github-app-credentials'
import { appBoundGitEnv, appGitConfigFile } from './github-app-git-credential-env'

type AppBoundRepo = { path: string; ghAccount?: GhAccountBinding }

/**
 * Whether this repository expects git to act as its bound App.
 *
 * A repository bound to an App whose App is no longer connected fails here rather than pushing as the
 * user's login: that commit would carry a different author and a different account's permission.
 */
export async function isAppBoundGitRepo(repo: AppBoundRepo): Promise<boolean> {
  if (!repo.ghAccount || !isAppGhAccountBinding(repo.ghAccount)) {
    return false
  }
  if (await readGithubAppCredentials()) {
    return true
  }
  throw createGhBoundAccountUnavailableError(
    repo.ghAccount,
    'This project is bound to the GitHub App and no App is connected on this computer, so git cannot act as it. Connect the App in Settings › Bots, or clear this project’s GitHub account.'
  )
}

/** The child environment that makes this repository's git act as its bound App; undefined without one. */
export async function appBoundRepoGitEnv(
  repo: AppBoundRepo
): Promise<NodeJS.ProcessEnv | undefined> {
  return (await isAppBoundGitRepo(repo))
    ? appBoundGitEnv({ repoFolder: repo.path, baseEnv: withOrcaCliOnPath() })
    : undefined
}

/**
 * A git child does not get the CLI prepended the way a terminal does, and the helper has to be found.
 * The launcher's own directory only — the full helper reads the filesystem, and a push must not.
 */
function withOrcaCliOnPath(): NodeJS.ProcessEnv {
  const launcher = hasAppEnvironment() ? (getAppEnvironment().getCliLauncherPath?.() ?? null) : null
  if (!launcher) {
    return process.env
  }
  const binDir = dirname(launcher)
  const key = resolvePathEnvKey(process.env, process.platform)
  const inherited = (process.env[key] ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== binDir)
  return {
    ...process.env,
    [key]: [binDir, ...inherited].join(delimiter),
    ORCA_CLI_COMMAND: launcher
  }
}

/**
 * The launch environment that makes a bot session's own `git` act as the App. A config file plus
 * `GIT_CONFIG_GLOBAL`, not `GIT_CONFIG_KEY_n`: agent CLIs scrub key/token names from the environment they
 * hand their commands, which would leave git a count with no keys and fail every command (#26594).
 *
 * Written even when no App is currently connected, so the push itself reports the stale binding rather
 * than the bot failing to start.
 */
export async function appBoundRepoGitLaunchEnv(input: {
  repo: AppBoundRepo
  botId: string
  baseEnv?: NodeJS.ProcessEnv
}): Promise<Record<string, string>> {
  if (!isAppGhAccountBinding(input.repo.ghAccount)) {
    return {}
  }
  const path = join(
    botsRootFolder(),
    '.git-config',
    input.botId,
    `${repoFolderKey(input.repo.path)}.gitconfig`
  )
  const text = appGitConfigFile({
    repoFolder: input.repo.path,
    ...(input.baseEnv ? { baseEnv: input.baseEnv } : {})
  })
  const existing = await readFile(path, 'utf8').catch(() => null)
  if (existing !== text) {
    await mkdir(dirname(path), { recursive: true })
    // A session may already be running this file: write beside it and rename, never half a config.
    const staged = `${path}.${randomUUID()}.tmp`
    await writeFile(staged, text, { mode: 0o600 })
    await rename(staged, path)
  }
  return { GIT_CONFIG_GLOBAL: path }
}

/** A stable filename per repository, so a relaunch rewrites one file instead of filling a directory. */
function repoFolderKey(repoFolder: string): string {
  const readable = repoFolder
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-60)
  return `${readable || 'repo'}-${Buffer.from(repoFolder).toString('base64url').slice(-12)}`
}
