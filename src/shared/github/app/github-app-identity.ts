/** A GitHub App acts as `<slug>[bot]`: tokens last an hour, and minting one takes a JWT signed with the App key. */

/** Longest a JWT may live with GitHub; also backdated so a host whose clock runs fast is not rejected. */
export const GITHUB_APP_JWT_BACKDATE_SECONDS = 60
export const GITHUB_APP_JWT_LIFETIME_SECONDS = 540

/** Mint again this long before expiry: a bot's turn can outlive a token that only just looked fresh. */
export const GITHUB_APP_TOKEN_REFRESH_MARGIN_MS = 600_000

export const GITHUB_APP_BOT_SUFFIX = '[bot]'

export type GithubAppJwtClaims = { iat: number; exp: number; iss: number }

/** The login an App acts as. GitHub appends `[bot]` and reserves the suffix for Apps, so it is a safe marker. */
export function githubAppBotLogin(slug: string): string {
  return `${slug.trim()}${GITHUB_APP_BOT_SUFFIX}`
}

/** `iss` is the App id, not the installation id — the two are different numbers and only one signs. */
export function githubAppJwtClaims(appId: number, nowMs: number): GithubAppJwtClaims {
  const issued = Math.floor(nowMs / 1000) - GITHUB_APP_JWT_BACKDATE_SECONDS
  return { iat: issued, exp: issued + GITHUB_APP_JWT_LIFETIME_SECONDS, iss: appId }
}

/** An unknown expiry counts as stale: nothing knows a token with no recorded expiry is still good. */
export function githubAppTokenNeedsRefresh(
  expiresAtMs: number | null,
  nowMs: number,
  marginMs: number = GITHUB_APP_TOKEN_REFRESH_MARGIN_MS
): boolean {
  return expiresAtMs === null || expiresAtMs - marginMs <= nowMs
}

/** `all` covers every repo the account owns; `selected` only the listed ones. */
export type GithubAppRepositorySelection = 'all' | 'selected'

export type GithubAppCoverage = 'all' | 'selected' | 'none'

function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Whether an installation can act on `repoFullName` (`owner/name`). `none` is the answer that matters: a
 * caller must not fall through to another identity, because the App and a person write different commits.
 */
export function githubAppCoversRepo(input: {
  repositorySelection: GithubAppRepositorySelection
  /** The account the installation belongs to: `all` covers that account's repos and no others. */
  account: string
  repositories: readonly string[]
  repoFullName: string
}): GithubAppCoverage {
  if (input.repositorySelection === 'all') {
    const owner = input.repoFullName.split('/')[0] ?? ''
    return sameRepo(input.account, owner) ? 'all' : 'none'
  }
  return input.repositories.some((repo) => sameRepo(repo, input.repoFullName)) ? 'selected' : 'none'
}

/**
 * The installation a bot acts as: the one covering `repoFullName` when that repo is known, else the first,
 * which is the only answer a Settings read can give.
 */
export function githubAppInstallationFor<
  T extends {
    repositorySelection: GithubAppRepositorySelection
    account: string
    repositories: readonly string[]
  }
>(installations: readonly T[], repoFullName?: string | null): T | null {
  if (!repoFullName) {
    return installations[0] ?? null
  }
  // No fallback for a known repo: the first installation is a token that cannot act there.
  return (
    installations.find(
      (installation) =>
        githubAppCoversRepo({
          repositorySelection: installation.repositorySelection,
          account: installation.account,
          repositories: installation.repositories,
          repoFullName
        }) !== 'none'
    ) ?? null
  )
}
