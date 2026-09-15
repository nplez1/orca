import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { extractExecError } from '../../git/exec-error'
import { ghExecFileAsync } from '../../git/command-runner/gh-exec-file'
import { isHostCommandMissing } from '../../git/command-runner/github-cli-host-fallback'
import { buildCopilotEntitlementSnapshot, makeCopilotError } from './copilot-fetcher-data'

/**
 * Reads the user's Copilot entitlement: the premium-interaction credits they are entitled
 * to this month and how many they have already consumed. One endpoint is enough because
 * GitHub reports the ceiling and the consumption together.
 *
 * Why through `gh` rather than `net.fetch`: every authenticated GitHub call in Orca goes
 * through the CLI, and going direct would be the only exception — losing GitHub
 * Enterprise Server host resolution and bypassing the gh rate-limit breaker. It also
 * means this provider never holds a token of its own: the CLI's own sign-in is the
 * credential, so this reads whatever account `gh` is logged in as.
 */
// Why: this endpoint is version-gated; earlier versions do not expose it.
const GITHUB_API_VERSION = '2026-03-10'
const HTTP_STATUS_IN_GH_ERROR = /\(HTTP (\d{3})\)/

type GhApiResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'http-error'; httpStatus: number }
  | { status: 'parse-error' }
  | { status: 'cli-missing' }
  | { status: 'cli-error'; message: string }

async function ghApiJson(path: string): Promise<GhApiResult> {
  try {
    const { stdout } = await ghExecFileAsync([
      'api',
      path,
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
    ])
    try {
      return { status: 'ok', payload: JSON.parse(stdout) }
    } catch {
      return { status: 'parse-error' }
    }
  } catch (error) {
    if (isHostCommandMissing(error, 'gh')) {
      return { status: 'cli-missing' }
    }
    // gh reports the API status inside its error text, e.g. "gh: Not Found (HTTP 404)".
    const { stderr } = extractExecError(error)
    const statusMatch = HTTP_STATUS_IN_GH_ERROR.exec(stderr)
    return statusMatch
      ? { status: 'http-error', httpStatus: Number(statusMatch[1]) }
      : { status: 'cli-error', message: stderr.trim() }
  }
}

/**
 * Maps a gh failure onto the shared failure vocabulary so the renderer's existing error
 * copy explains the cause instead of showing a bare "Usage unavailable".
 */
function makeCopilotFailure(what: string, failure: GhApiResult): ProviderRateLimits {
  if (failure.status === 'ok') {
    // Unreachable: callers only route failures here.
    return makeCopilotError(`Unexpected success while reading ${what}`)
  }
  if (failure.status === 'cli-error') {
    return makeCopilotError(`Could not read ${what} through the GitHub CLI: ${failure.message}`)
  }
  if (failure.status === 'parse-error') {
    return makeCopilotError(`GitHub returned unreadable JSON for ${what}`, 'parse')
  }
  if (failure.status === 'cli-missing') {
    return makeCopilotError(
      `Reading ${what} needs the GitHub CLI — install gh and run gh auth login`,
      'cli-unavailable'
    )
  }
  if (failure.httpStatus === 401) {
    return makeCopilotError(
      `GitHub rejected the GitHub CLI sign-in while reading ${what}`,
      'stale-token'
    )
  }
  if (failure.httpStatus === 403) {
    return makeCopilotError(
      `The GitHub CLI sign-in cannot read ${what} — refresh it with the user scope`,
      'missing-scope'
    )
  }
  if (failure.httpStatus === 404) {
    return makeCopilotError(
      'GitHub did not expose a Copilot entitlement for this account',
      'usage-unavailable'
    )
  }
  if (failure.httpStatus >= 500) {
    return makeCopilotError(`GitHub server error while reading ${what}`, 'server')
  }
  return makeCopilotError(`GitHub returned ${failure.httpStatus} for ${what}`)
}

export async function fetchCopilotRateLimits(): Promise<ProviderRateLimits> {
  try {
    const result = await ghApiJson('/copilot_internal/user')
    if (result.status !== 'ok') {
      return makeCopilotFailure('your Copilot entitlement', result)
    }
    const snapshot = buildCopilotEntitlementSnapshot(result.payload)
    return (
      snapshot ??
      makeCopilotError('GitHub returned no usable premium-interaction entitlement', 'parse')
    )
  } catch (error) {
    return makeCopilotError(error instanceof Error ? error.message : String(error), 'unknown')
  }
}
