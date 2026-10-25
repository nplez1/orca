import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { runKeyedSerializedOperation } from './cli/keyed-promise-queue'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
import { runExclusivelyForCodexTrustConfig } from './codex/codex-trust-config-mutation-queue'
import type { TuiAgentConfig } from '../shared/tui-agent-config'

export type AgentTrustPreset = NonNullable<TuiAgentConfig['preflightTrust']>

// Prewrite workspace trust so first-launch menus cannot consume a drafted URL as input.
// Trust artifacts preserve the agent’s approval and sandbox policy.

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
export async function markCursorWorkspaceTrusted(
  workspacePath: string,
  home: string
): Promise<void> {
  const absPath = await canonicalize(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return
  }
  const trustDir = join(home, '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
}

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
export async function markCopilotFolderTrusted(workspacePath: string, home: string): Promise<void> {
  const configDir = join(home, '.copilot')
  await appendTrustedConfigEntry({
    configPath: join(configDir, 'config.json'),
    configDir,
    key: 'trustedFolders',
    workspacePath,
    // Why: config.json can hold copilotTokens, so it must stay owner-only (also on shared SSH hosts).
    mode: 0o600
  })
}

/**
 * The Antigravity CLI (agy) keeps its trusted workspaces in
 * ~/.gemini/antigravity-cli/settings.json under `trustedWorkspaces`, a flat
 * array of absolute paths in native OS form.
 *
 * Verified empirically against agy 1.2.7 on Windows: accepting the CLI's
 * "Do you trust the contents of this project?" prompt for a freshly created
 * worktree appended exactly that worktree's path to this array. Note this is
 * NOT ~/.gemini/trustedFolders.json — that file belongs to the Gemini CLI and
 * agy does not consult it.
 *
 * Trust is exact-path and NOT inherited by subdirectories: `C:\Users\<you>`
 * was already present in the array, yet launching agy in a descendant still
 * raised the prompt and appended the descendant separately. Every new child
 * worktree therefore needs its own entry, which is precisely what this
 * per-worktree preflight provides.
 *
 * We append in-place so the sibling keys in the same file (model, permissions,
 * toolPermission, agentMode, …) survive untouched.
 */
export async function markAntigravityWorkspaceTrusted(
  workspacePath: string,
  home: string
): Promise<void> {
  const configDir = join(home, '.gemini', 'antigravity-cli')
  await appendTrustedConfigEntry({
    configPath: join(configDir, 'settings.json'),
    configDir,
    key: 'trustedWorkspaces',
    workspacePath
  })
}

/** An agent config that holds an array of trusted folder paths, keyed by one property. */
type TrustedEntryConfig = {
  configPath: string
  configDir: string
  key: 'trustedFolders' | 'trustedWorkspaces'
  workspacePath: string
  mode?: number
}

const trustedConfigWriteQueue = new Map<string, Promise<void>>()

/** The config as a plain object, `{}` when absent, or null when it cannot be extended as one. */
function readTrustedConfig(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'))
    // Why null and not `{}`: a top level that is not an object is not a config this path can extend,
    // and writing over it would drop whatever the agent keeps there.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    // Why: a corrupted config is the user's to fix — refuse to overwrite it from this
    // side-effect path. The agent rewrites the file itself after the user accepts the prompt.
    return null
  }
}

function trustedEntries(config: Record<string, unknown>, key: TrustedEntryConfig['key']): string[] {
  const value = config[key]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Appends `workspacePath` to an agent's trusted-folder array, at most once.
 *
 * Why re-read before writing: realpath awaits open a window the sync version did not have. Two
 * launches at once both read N entries and both write N+1, so one workspace loses its entry; and
 * when the trusted folders sit on a stalled volume, the entry realpaths outlast the launch deadline
 * and a late write would put back a snapshot that has already missed the agent's own rewrite (an
 * entry, `copilotTokens`, …). So the file is read again in the same tick as the write, and Orca's
 * writers for one config are serialized.
 */
async function appendTrustedConfigEntry(args: TrustedEntryConfig): Promise<void> {
  const absPath = await canonicalize(args.workspacePath)
  const initial = readTrustedConfig(args.configPath)
  if (!initial) {
    return
  }
  // Why one at a time: entries on a dead mount would otherwise pin every libuv fs thread at once.
  for (const entry of trustedEntries(initial, args.key)) {
    if ((await canonicalize(entry)) === absPath) {
      return
    }
  }
  await runKeyedSerializedOperation(trustedConfigWriteQueue, args.configPath, async () => {
    const config = readTrustedConfig(args.configPath)
    if (!config) {
      return
    }
    const existing = trustedEntries(config, args.key)
    if (existing.includes(absPath)) {
      return
    }
    config[args.key] = [...existing, absPath]
    if (!existsSync(args.configDir)) {
      mkdirSync(args.configDir, { recursive: true })
    }
    writeFileAtomically(
      args.configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      args.mode === undefined ? undefined : { mode: args.mode }
    )
  })
}

/** Kimi Code 2.3.1 keeps one exact-folder record per cwd (workspaceTrust/trustRecord.ts). */
export async function markKimiWorkspaceTrusted(
  workspacePath: string,
  kimiHome: string
): Promise<void> {
  // Kimi keys on process.cwd(): physical on POSIX, the spawn path as given on Windows.
  const root =
    process.platform === 'win32' ? resolve(workspacePath) : await canonicalize(workspacePath)
  const trustFile = join(kimiHome, 'workspace-trust', kimiWorkspaceTrustKey(root))
  if (existsSync(trustFile)) {
    return
  }
  mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 })
  writeFileAtomically(trustFile, JSON.stringify({ root, trustedAt: Date.now() }), { mode: 0o600 })
}

/** Mirrors Kimi's trustKey: canonicalWorkspaceRoot then encodeWorkDirKey (workdir-slug.ts). */
function kimiWorkspaceTrustKey(root: string): string {
  const slashed = root.replaceAll('\\', '/')
  const trimmed = slashed.replace(/\/+$/, '')
  const normalized = /^(?:[A-Za-z]:\/|\/\/)/.test(slashed) ? trimmed.toLowerCase() : trimmed
  const slug = (normalized.split('/').pop() ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 40)
    .replaceAll(/^-+|-+$/g, '')
  const name = slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  return `wd_${name}_${hash}`
}

/** Lock configs in hook-installer order: managed runtime home before system home. */
export async function markCodexProjectTrusted(
  workspacePath: string,
  configFiles: readonly string[]
): Promise<void> {
  // Why: Codex checks the cwd's own entry before the repo root, so no git-layout logic is needed.
  const absPath = await canonicalize(workspacePath)
  // Why (#16441): hook installs read and rewrite these files across awaits, so
  // an unqueued write here could land between their read and their write and be
  // lost. Same runtime-before-system lock order the installer takes.
  const write = configFiles.reduceRight<() => Promise<void>>(
    (inner, configFile) => () => runExclusivelyForCodexTrustConfig(configFile, inner),
    async () => {
      for (const configFile of configFiles) {
        upsertProjectTrustLevel(configFile, absPath, 'trusted')
      }
    }
  )
  return write()
}

async function canonicalize(p: string): Promise<string> {
  // Why: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, but
  // both Cursor and Copilot's trust comparators run realpath() before the
  // string compare. Mirror that so a worktree under a symlinked parent
  // (orca caches realpath()'d worktree paths) matches the agent's lookup.
  // Why async: realpath on the workspace path is a probe of the repo's volume, and a stalled one
  // would freeze the app mid-launch. A missing path throws and keeps the raw input, as existsSync did.
  try {
    return await realpath(p)
  } catch {
    return p
  }
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Windows paths contain characters forbidden in Cursor’s project-directory names.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
