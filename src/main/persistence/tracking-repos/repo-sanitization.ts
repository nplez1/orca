import type { RepoProjectHostSetupMethod } from '../../../shared/project-types'
import { isWorktreeSharedDirectoriesMode, type Repo } from '../../../shared/repo-types'
import type { GitRemoteIdentity } from '../../../shared/git-remote-identity'
import { normalizeRepoBadgeColor } from '../../../shared/repo-badge-color'
import { sanitizeRepoIcon } from '../../../shared/repo-icon'
import { normalizeGhAccountBinding } from '../../../shared/github/account-binding'
import { normalizeJiraProjectReference } from '../../../shared/jira/jira-project-reference'
import type { GhAccountBinding } from '../../../shared/github/account-binding'
import {
  normalizeCustomWorktreeVisibilitySources,
  normalizeWorktreeVisibilitySourcePreferences
} from '../../../shared/worktree/visibility-sources'

export function sanitizeRepoUpstream(value: unknown): Repo['upstream'] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as { owner?: unknown; repo?: unknown; host?: unknown }
  const owner = typeof candidate.owner === 'string' ? candidate.owner.trim() : ''
  const repo = typeof candidate.repo === 'string' ? candidate.repo.trim() : ''
  if (!owner || !repo) {
    return undefined
  }
  // Preserve upstream host identity to distinguish GHES forks from same-named github.com repos.
  const host = typeof candidate.host === 'string' ? candidate.host.trim() : ''
  return host ? { owner, repo, host } : { owner, repo }
}

/** A named owner type for this boundary's input: anti-slop refuses the broad `object` parameter. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown record field to a trimmed string without an assertion the lint gate forbids. */
function readTrimmed(source: Record<string, unknown>, key: string): string {
  const entry = source[key]
  return typeof entry === 'string' ? entry.trim() : ''
}

export function sanitizeGitRemoteIdentity(value: unknown): GitRemoteIdentity | null | undefined {
  // Null means resolved with no usable remote; absence means identity probing is pending.
  if (value === null) {
    return null
  }
  if (!isUnknownRecord(value)) {
    return undefined
  }
  const canonicalKey = readTrimmed(value, 'canonicalKey')
  const remoteName = readTrimmed(value, 'remoteName')
  const remoteUrl = readTrimmed(value, 'remoteUrl')
  if (!canonicalKey || !remoteName || !remoteUrl) {
    return undefined
  }
  // fork-comment-ok: fork-only identity field; the why must sit above the code a sync rewrites.
  // Why: dropping this here would unreach every fork's own remote — the value is written by the
  // probe and read by the link scope checks, both of which run on either side of this boundary.
  const remoteKeys = Array.isArray(value.remoteKeys)
    ? [
        ...new Set(
          value.remoteKeys
            .filter((key): key is string => typeof key === 'string')
            .map((key) => key.trim())
            .filter((key) => key.length > 0)
        )
      ]
    : []
  return {
    canonicalKey,
    remoteName,
    remoteUrl,
    ...(remoteKeys.length > 0 ? { remoteKeys } : {})
  }
}

export function sanitizeRepoProjectHostSetupMethod(
  value: unknown
): RepoProjectHostSetupMethod | undefined {
  return value === 'imported-existing-folder' || value === 'cloned' ? value : undefined
}

export function sanitizeForkSyncMode(value: unknown): Repo['forkSyncMode'] | undefined {
  return value === 'ask' || value === 'safe-auto' || value === 'off' ? value : undefined
}

export function sanitizeWorktreeSharedDirectoriesMode(
  value: unknown
): Repo['sharedDirectoriesMode'] | undefined {
  return isWorktreeSharedDirectoriesMode(value) ? value : undefined
}

export function sanitizeRepoUpdatesForPersistence<
  T extends Partial<
    Pick<
      Repo,
      | 'badgeColor'
      | 'repoIcon'
      | 'upstream'
      | 'gitRemoteIdentity'
      | 'worktreeBasePath'
      | 'projectHostSetupMethod'
      | 'forkSyncMode'
      | 'sharedDirectoriesMode'
      | 'defaultJiraProject'
      | 'customWorktreeVisibilitySources'
      | 'worktreeVisibilitySourcePreferences'
    >
  > & {
    ghAccount?: GhAccountBinding | null
  }
>(updates: T): T {
  const sanitized = { ...updates }
  if ('defaultJiraProject' in sanitized) {
    const reference = normalizeJiraProjectReference(sanitized.defaultJiraProject)
    if (reference === undefined) {
      delete sanitized.defaultJiraProject
    } else {
      sanitized.defaultJiraProject = reference
    }
  }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  // Preserve explicit null markers; discard only malformed values.
  if ('upstream' in sanitized) {
    const upstream = sanitizeRepoUpstream(sanitized.upstream)
    if (upstream === undefined) {
      delete sanitized.upstream
    } else {
      sanitized.upstream = upstream
    }
  }
  if ('gitRemoteIdentity' in sanitized) {
    const gitRemoteIdentity = sanitizeGitRemoteIdentity(sanitized.gitRemoteIdentity)
    if (gitRemoteIdentity === undefined) {
      delete sanitized.gitRemoteIdentity
    } else {
      sanitized.gitRemoteIdentity = gitRemoteIdentity
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    if (typeof sanitized.worktreeBasePath === 'string') {
      sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
    } else {
      delete sanitized.worktreeBasePath
    }
  }
  if ('projectHostSetupMethod' in sanitized) {
    const setupMethod = sanitizeRepoProjectHostSetupMethod(sanitized.projectHostSetupMethod)
    if (setupMethod === undefined) {
      delete sanitized.projectHostSetupMethod
    } else {
      sanitized.projectHostSetupMethod = setupMethod
    }
  }
  if ('forkSyncMode' in sanitized) {
    const forkSyncMode = sanitizeForkSyncMode(sanitized.forkSyncMode)
    if (forkSyncMode === undefined) {
      delete sanitized.forkSyncMode
    } else {
      sanitized.forkSyncMode = forkSyncMode
    }
  }
  if ('sharedDirectoriesMode' in sanitized) {
    const mode = sanitizeWorktreeSharedDirectoriesMode(sanitized.sharedDirectoriesMode)
    if (mode === undefined) {
      delete sanitized.sharedDirectoriesMode
    } else {
      sanitized.sharedDirectoriesMode = mode
    }
  }
  // fork-comment-ok: fork-only identity field; the why must sit above the code a sync rewrites.
  // Why: `null` is the clear sentinel for updateRepo; only malformed shapes are dropped.
  if ('ghAccount' in sanitized && sanitized.ghAccount != null) {
    const ghAccount = normalizeGhAccountBinding(sanitized.ghAccount)
    if (!ghAccount) {
      delete sanitized.ghAccount
    } else {
      sanitized.ghAccount = ghAccount
    }
  }
  if ('customWorktreeVisibilitySources' in sanitized) {
    const sources = normalizeCustomWorktreeVisibilitySources(
      sanitized.customWorktreeVisibilitySources
    )
    if (!sources) {
      delete sanitized.customWorktreeVisibilitySources
    } else {
      sanitized.customWorktreeVisibilitySources = sources
    }
  }
  if ('worktreeVisibilitySourcePreferences' in sanitized) {
    const preferences = normalizeWorktreeVisibilitySourcePreferences(
      sanitized.worktreeVisibilitySourcePreferences
    )
    if (!preferences) {
      delete sanitized.worktreeVisibilitySourcePreferences
    } else {
      sanitized.worktreeVisibilitySourcePreferences = preferences
    }
  }
  return sanitized
}
