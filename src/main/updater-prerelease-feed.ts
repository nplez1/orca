import { net } from 'electron'
import { FETCH_TIMEOUT_MS, RELEASES_REPO } from './updater-release-targets'
import { getPlatformManifestReadiness, requestGitHubReleaseHead } from './updater-release-readiness'
import {
  compareVersions,
  isForkReleaseVersion,
  isPrereleaseVersion,
  isValidVersion
} from './updater-fallback'

// Why callers keep importing this from here: the updater's tests mock this module wholesale, so the
// surface they pin has to stay on it.
export { getReleaseDownloadUrl } from './updater-release-targets'

const RELEASES_API_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`
const ATOM_FEED_URL = `https://github.com/${RELEASES_REPO}/releases.atom`
// How many newer candidates are probed when the feed holds fewer than this. The tag after the
// primary is the fallback feed a missing manifest walks back to, so the window must reach past
// the primary even when nothing newer is left to probe.
const MAX_MANIFEST_PROBE_CANDIDATES = 6

// Each feed entry carries a /releases/tag/<tag> URL we can mine without any channel filtering.
const TAG_HREF_RE = new RegExp(
  `href="https://github\\.com/${RELEASES_REPO}/releases/tag/([^"]+)"`,
  'g'
)

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = {
  tag: string
  version: string
}

export function isPerfPrereleaseTag(tag: string): boolean {
  const version = normalizeTagToVersion(tag)
  const match = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-.]+)(?:\+[0-9A-Za-z-.]+)?$/)
  const identifiers = match?.[1]?.split('.') ?? []
  return (
    identifiers.length === 3 &&
    identifiers[0] === 'rc' &&
    /^\d+$/.test(identifiers[1]) &&
    identifiers[2] === 'perf'
  )
}

// Why the release list and not the feed: GitHub's atom feed lists *tags*, not releases, and caps
// them at ten. A sync mirrors upstream's tags into this repo, so most of the ten are tags with no
// release and no manifest in this repo — and the fork's own release is pushed out of the feed
// entirely on a busy day, which every installed build reads as "no update available". The REST
// list is this repo's releases only, up to a hundred of them, and a mirrored tag has no release.
//
// Why the atom feed is still here: an unauthenticated REST call shares a 60/hour per-IP quota, and
// a rate-limited or offline client has to keep working. The feed is a smaller, noisier answer, not
// a broken one.
async function fetchReleaseFeedTags(): Promise<ReleaseFeedTag[] | null> {
  const tags = (await fetchReleaseListTags()) ?? (await fetchReleaseAtomTags())
  if (!tags) {
    return null
  }
  tags.sort((left, right) => compareVersions(right.version, left.version))
  return tags
}

type GitHubReleaseListEntry = {
  tag_name?: unknown
  draft?: unknown
  assets?: unknown
}

async function fetchReleaseListTags(): Promise<ReleaseFeedTag[] | null> {
  try {
    const res = await net.fetch(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) {
      return null
    }
    const payload: unknown = JSON.parse(await res.text())
    if (!Array.isArray(payload)) {
      return null
    }
    const entries: (GitHubReleaseListEntry | null)[] = payload
    const tags: ReleaseFeedTag[] = []
    for (const entry of entries) {
      // A bare tag has no release at all, but a draft or an asset-less release is the same dead
      // end for the updater: there is nothing at releases/download/<tag> to pin a feed to.
      if (
        !entry ||
        entry.draft === true ||
        !Array.isArray(entry.assets) ||
        entry.assets.length === 0
      ) {
        continue
      }
      const tag = typeof entry.tag_name === 'string' ? entry.tag_name : null
      if (!tag) {
        continue
      }
      const version = normalizeTagToVersion(tag)
      if (!isValidVersion(version)) {
        continue
      }
      tags.push({ tag, version })
    }
    return tags
  } catch {
    return null
  }
}

async function fetchReleaseAtomTags(): Promise<ReleaseFeedTag[] | null> {
  try {
    const res = await net.fetch(ATOM_FEED_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      return null
    }
    const body = await res.text()
    const tags: ReleaseFeedTag[] = []

    for (const match of body.matchAll(TAG_HREF_RE)) {
      const tag = match[1]
      const version = normalizeTagToVersion(tag)
      if (isValidVersion(version)) {
        tags.push({ tag, version })
      }
    }

    return tags
  } catch {
    return null
  }
}

export async function fetchLatestStableReleaseTag(): Promise<string | null> {
  try {
    // Resolve only the release-page redirect; installer redirects continue on to signed storage URLs.
    const latestUrl = `https://github.com/${RELEASES_REPO}/releases/latest`
    const response = await requestGitHubReleaseHead(latestUrl)
    if (!response?.redirectUrl || response.statusCode < 300 || response.statusCode >= 400) {
      return null
    }
    const target = new URL(response.redirectUrl, latestUrl)
    // Derived from the one declaration of the repo, so a retarget cannot leave this regex behind.
    const tagPathPrefix = `/${RELEASES_REPO}/releases/tag/`
    if (target.origin !== 'https://github.com' || !target.pathname.startsWith(tagPathPrefix)) {
      return null
    }
    const tag = decodeURIComponent(target.pathname.slice(tagPathPrefix.length))
    const version = normalizeTagToVersion(tag)
    // Why the fork's own line is allowed here: every release this fork publishes carries the
    // `-np.<n>` prerelease suffix, so rejecting prereleases rejected the only thing `releases/latest`
    // can resolve to here — the fallback could never pin a feed.
    if (
      !isValidVersion(version) ||
      (isPrereleaseVersion(version) && !isForkReleaseVersion(version))
    ) {
      return null
    }
    return (await getPlatformManifestReadiness(tag)) === 'ready' ? tag : null
  } catch {
    return null
  }
}

// Concrete tags keep manifests and downloaded assets on the same release.
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
  releaseFilter?: 'perf'
}

export type FetchNewerReleaseTagsResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

export async function fetchNewerReleaseTag(
  currentVersion: string,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string | null> {
  return (await fetchNewerReleaseTags(currentVersion, 1, options))[0] ?? null
}

export async function fetchNewerReleaseTags(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string[]> {
  return (await fetchNewerReleaseTagsWithReadiness(currentVersion, maxTags, options)).tags
}

export async function fetchNewerReleaseTagsWithReadiness(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<FetchNewerReleaseTagsResult> {
  const includePrerelease = options.includePrerelease ?? true
  if (maxTags <= 0) {
    return { tags: [], state: 'no-newer' }
  }
  const tags = await fetchReleaseFeedTags()
  if (!tags) {
    return { tags: [], state: 'unavailable', unavailableReason: 'feed' }
  }

  // Perf builds require explicit opt-in, even when semver considers them newer.
  const candidates =
    options.releaseFilter === 'perf'
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
  const newestNewerIndex = candidates.findIndex(
    ({ version }) => compareVersions(version, currentVersion) > 0
  )
  if (newestNewerIndex === -1) {
    return { tags: [], state: 'no-newer' }
  }

  // Why every newer candidate, and not just the first six: the atom fallback carries tags with no
  // manifest in this repo, and six of them sorting above this repo's own tag filled a six-wide
  // window completely, which deferred every check indefinitely and left installed builds with no
  // update offer at all. The window keeps its original width as a floor, because the tag after the
  // primary is the fallback feed a missing manifest walks back to. See LOCAL-PATCHES.md.
  const newerCandidateCount = candidates.filter(
    ({ version }) => compareVersions(version, currentVersion) > 0
  ).length
  const probeCandidates = candidates.slice(
    newestNewerIndex,
    newestNewerIndex + Math.max(newerCandidateCount, MAX_MANIFEST_PROBE_CANDIDATES)
  )
  const manifestResults = await Promise.all(
    probeCandidates.map(async ({ tag, version }) => ({
      tag,
      version,
      readiness: await getPlatformManifestReadiness(tag)
    }))
  )

  const primaryIndex = manifestResults.findIndex(
    ({ readiness, version }) =>
      readiness === 'ready' && compareVersions(version, currentVersion) > 0
  )
  if (primaryIndex === -1) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    const lastGoodTag = manifestResults.find(({ readiness }) => readiness === 'ready')?.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  if (primaryIndex > 0) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    return { tags: [], state: 'not-ready', lastGoodTag: manifestResults[primaryIndex].tag }
  }

  return {
    tags: manifestResults
      .slice(primaryIndex)
      .filter(({ readiness }) => readiness === 'ready')
      .slice(0, maxTags)
      .map(({ tag }) => tag),
    state: 'ready'
  }
}
