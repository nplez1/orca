export function normalizeHostedReviewHeadRef(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/[^/]+\//, '')
}

export function normalizeHostedReviewBaseRef(ref: string): string {
  const normalized = normalizeHostedReviewHeadRef(ref)
  return normalized.replace(/^(origin|upstream)\//, '')
}

type ReviewRepoIdentity = { owner: string; repo: string }

/**
 * The `head` a hosted review is created with.
 *
 * GitHub only accepts a bare branch when it lives in the repo the review is
 * created in; a branch that lives in a fork must be owner-qualified, or the
 * create silently opens a review inside the fork instead of against the parent.
 */
export function hostedReviewHeadRef(
  base: ReviewRepoIdentity | null | undefined,
  head: ReviewRepoIdentity | null | undefined,
  branch: string
): string {
  if (!base || !head) {
    return branch
  }
  const sameRepo =
    base.owner.toLowerCase() === head.owner.toLowerCase() &&
    base.repo.toLowerCase() === head.repo.toLowerCase()
  return sameRepo ? branch : `${head.owner}:${branch}`
}

/** Exclude only a remote's direct symbolic HEAD, preserving branches like feature/HEAD. */
export function isRemoteHeadRef(ref: string, remotes: readonly string[] = []): boolean {
  // Every true result ends in `/HEAD`, so ordinary refs can skip the remote copy+sort.
  if (!ref.endsWith('/HEAD')) {
    return false
  }
  const shortRef = ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => shortRef.startsWith(`${candidate}/`))
  if (remote) {
    return shortRef.slice(remote.length + 1) === 'HEAD'
  }
  // A stale ref whose remote is no longer configured is unambiguous only in
  // the conventional two-component `<remote>/HEAD` shape.
  return shortRef.split('/').length === 2 && shortRef.endsWith('/HEAD')
}
