import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from '../testing/updater-net-request.fixture'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ARCH = process.arch

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

function buildAtomFeed(tags: string[], updatedAt: Record<string, string> = {}): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry>${updatedAt[tag] ? `<updated>${updatedAt[tag]}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/nplez1/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
}

const RELEASES_API_URL = 'https://api.github.com/repos/nplez1/orca/releases?per_page=100'
const ATOM_FEED_URL = 'https://github.com/nplez1/orca/releases.atom'

/**
 * The REST release list the resolver reads first, plus the atom feed it falls back to. Why both: the
 * feed lists tags and the list lists releases, and the difference is the whole bug — nine mirrored
 * upstream tags fill the feed and push this repo's release out of it.
 */
function respondWithReleases(
  releaseTags: string[],
  options: { atomTags?: string[]; draftTags?: string[]; bareTags?: string[] } = {}
): void {
  const drafts = new Set(options.draftTags ?? [])
  const bare = new Set(options.bareTags ?? [])
  const atomTags = options.atomTags ?? []
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === RELEASES_API_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(
              releaseTags.map((tag) => ({
                tag_name: tag,
                draft: drafts.has(tag),
                assets: bare.has(tag) ? [] : [{ name: 'latest-mac.yml' }]
              }))
            )
          )
      })
    }
    if (url === ATOM_FEED_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(buildAtomFeed(atomTags))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      // A mirrored tag has no release in this repo, so its manifest is not there either.
      const missing = !releaseTags.includes(tag) || drafts.has(tag)
      return Promise.resolve({
        ok: !missing,
        status: missing ? 404 : 200,
        text: () => Promise.resolve(missing ? '' : buildManifest(tag))
      })
    }

    if (init?.method === 'HEAD') {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
    }

    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') })
  })
}

function buildManifest(tag: string): string {
  const version = tag.replace(/^v/i, '')
  return [
    `version: ${version}`,
    'files:',
    `  - url: Orca-${version}-arm64-mac.zip`,
    '    sha512: test',
    `path: Orca-${version}-arm64-mac.zip`
  ].join('\n')
}

function respondWithAtom(
  tags: string[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = [],
  unavailableManifestTags: string[] = [],
  updatedAt: Record<string, string> = {}
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === ATOM_FEED_URL) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags, updatedAt))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      if (unavailableManifests.has(tag)) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('')
        })
      }
      return Promise.resolve({
        ok: !missingManifests.has(tag),
        status: missingManifests.has(tag) ? 404 : 200,
        text: () => Promise.resolve(buildManifest(tag))
      })
    }

    const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
    if (assetMatch && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: !missingAssets.has(decodeURIComponent(assetMatch[1])),
        status: missingAssets.has(decodeURIComponent(assetMatch[1])) ? 404 : 200,
        text: () => Promise.resolve('')
      })
    }

    return Promise.resolve({
      ok: false,
      text: () => Promise.resolve('')
    })
  })
}

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

function setArchForTest(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'arch', { value: arch })
}

describe('fetchNewerReleaseTag', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    setPlatformForTest(ORIGINAL_PLATFORM)
    setArchForTest(ORIGINAL_ARCH)
  })

  it('reports not-ready with last-good when newer platform updater manifests are missing', async () => {
    respondWithAtom(
      ['v1.4.1-rc.4', 'v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'],
      ['v1.4.1-rc.4', 'v1.4.1-rc.3']
    )

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1-rc.1', 2)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1-rc.2'
    })
  })

  it('reports manifest transport failures as unavailable', async () => {
    respondWithAtom(['v1.4.2'], [], [], ['v1.4.2'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
  })

  it('reports not-ready with last-good when newer manifest assets are not reachable yet', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], ['v1.4.3'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.0')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.2'
    })
  })

  it('does not return the current tag as the primary update when newer manifests are missing', async () => {
    respondWithAtom(['v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'], ['v1.4.1-rc.3', 'v1.4.1-rc.2'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTags } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual([])
  })

  // Every newer candidate is probed, so a manifest-less entry cannot hide the release behind it:
  // a fork's feed also carries the parent's release entries, which have no manifest in this repo.
  // See LOCAL-PATCHES.md.
  it('probes every newer candidate concurrently', async () => {
    const feedTags = [
      'v1.4.8-rc.0',
      'v1.4.7-rc.0',
      'v1.4.6-rc.0',
      'v1.4.5-rc.0',
      'v1.4.4-rc.0',
      'v1.4.3-rc.0',
      'v1.4.2-rc.0',
      'v1.4.1-rc.0'
    ]
    const manifestUrls: string[] = []
    const manifestResolvers: (() => void)[] = []

    netFetchMock.mockImplementation((url: string) => {
      if (url === RELEASES_API_URL) {
        // This case is about the atom feed, which is only read when the list cannot be.
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
      }
      if (url === ATOM_FEED_URL) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(feedTags))
        })
      }

      manifestUrls.push(url)
      return new Promise((resolve) => {
        manifestResolvers.push(() => {
          resolve({ ok: false, text: () => Promise.resolve('') })
        })
      })
    })

    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    const result = fetchNewerReleaseTags('1.4.0-rc.0', 2)

    await vi.waitFor(() => {
      expect(manifestUrls).toHaveLength(feedTags.length)
    })
    expect(manifestResolvers).toHaveLength(feedTags.length)

    for (const resolveManifest of manifestResolvers) {
      resolveManifest()
    }

    await expect(result).resolves.toEqual([])
    // One release list, one atom feed, then one manifest probe per candidate.
    expect(netFetchMock).toHaveBeenCalledTimes(feedTags.length + 2)
  })

  // The live feed on 2026-10-29 held ten entries: two of this repo's releases and eight mirrored
  // upstream tags (the sync mirrors `v*` and `archive/*`). Nine new tags in a day push this repo's
  // newest release out of the feed entirely — and with no candidate left to probe, every installed
  // build reports it cannot reach the update server.
  it("finds this repo's own release when mirrored tags have crowded out the atom feed", async () => {
    respondWithReleases(['v1.4.214-np.41', 'v1.4.214-np.40'], {
      atomTags: [
        'v1.4.244',
        'v1.4.243',
        'archive/2026-10-27/nplez1-Fork-Opt',
        'v1.4.242',
        'v1.4.241',
        'v1.4.240',
        'archive/2026-10-27/nplez1-ci-nightly-unblock',
        'archive/2026-10-27/nplez1-Session-Summary',
        'v1.4.239',
        'v1.4.238'
      ]
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-np.40')).toBe('v1.4.214-np.41')
  })

  it('takes its candidate tags from the release list, not the atom feed', async () => {
    respondWithReleases(['v1.4.214-np.41'], { atomTags: ['v1.4.214-np.41', 'v1.4.500'] })
    const urls: string[] = []
    const respond = netFetchMock.getMockImplementation()
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      urls.push(url)
      return respond?.(url, init)
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-np.40')).toBe('v1.4.214-np.41')
    expect(urls[0]).toBe(RELEASES_API_URL)
    expect(urls).not.toContain(ATOM_FEED_URL)
  })

  it('ignores a draft or asset-less release, which no feed can be pinned to', async () => {
    respondWithReleases(['v1.4.214-np.42', 'v1.4.214-np.41', 'v1.4.214-np.40'], {
      draftTags: ['v1.4.214-np.42'],
      bareTags: ['v1.4.214-np.41']
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-np.39')).toBe('v1.4.214-np.40')
  })

  // 60 requests an hour per IP is the unauthenticated REST quota, so a throttled or offline client
  // still has to resolve updates from the feed.
  it('falls back to the atom feed when the release list is rate limited', async () => {
    respondWithReleases(['v1.4.214-np.42', 'v1.4.214-np.41'], { atomTags: ['v1.4.214-np.41'] })
    const respond = netFetchMock.getMockImplementation()
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === RELEASES_API_URL) {
        return Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('') })
      }
      return respond?.(url, init)
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-np.40')).toBe('v1.4.214-np.41')
  })

  it('falls back to the atom feed when the release list is not a release list', async () => {
    respondWithReleases(['v1.4.214-np.41'], { atomTags: ['v1.4.214-np.41'] })
    const respond = netFetchMock.getMockImplementation()
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === RELEASES_API_URL) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('<html>') })
      }
      return respond?.(url, init)
    })

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.214-np.40')).toBe('v1.4.214-np.41')
  })
})

describe('fetchNewerReleaseTagsWithReadiness update delay', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-11-02T12:00:00Z')
  const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()
  const delay = { includePrerelease: false, minReleaseAgeMs: 7 * DAY_MS, now: NOW }

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('offers the newest release past the delay and reports the newer one it holds', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(8),
      'v1.4.1': daysAgo(20)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual(['v1.4.2'])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.3',
      version: '1.4.3',
      releasedAt: NOW - DAY_MS
    })
  })

  it('holds everything when every newer release is inside the delay', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(3)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result).toMatchObject({ tags: [], state: 'no-newer' })
    expect(result.releaseDelay?.heldRelease?.tag).toBe('v1.4.3')
  })

  it('fails closed for releases without a feed timestamp', async () => {
    respondWithAtom(['v1.4.2'])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual([])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.2',
      version: '1.4.2',
      releasedAt: null
    })
  })
})
