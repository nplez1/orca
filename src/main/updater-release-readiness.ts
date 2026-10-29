import { net } from 'electron'
import { parse } from 'yaml'
import {
  getReleaseAssetUrl,
  getReleaseDownloadUrl,
  getPlatformManifestName
} from './updater-release-targets'

const FETCH_TIMEOUT_MS = 5000

/** Whether a tag has the platform manifest and installer assets an installed build could fetch. */
export type ReleaseReadiness = 'ready' | 'not-ready' | 'unavailable'

type ManifestAssetEntry = {
  url?: unknown
  path?: unknown
}

function getManifestAssetNames(manifestText: string): string[] {
  const parsed = parse(manifestText) as {
    files?: ManifestAssetEntry[]
    path?: unknown
  } | null

  const names = new Set<string>()
  for (const file of Array.isArray(parsed?.files) ? parsed.files : []) {
    const value = typeof file.url === 'string' ? file.url : file.path
    if (typeof value === 'string' && value.trim()) {
      names.add(value.trim())
    }
  }
  if (typeof parsed?.path === 'string' && parsed.path.trim()) {
    names.add(parsed.path.trim())
  }
  return [...names]
}

type ReleaseHeadResponse = { statusCode: number; redirectUrl?: string }

export function requestGitHubReleaseHead(assetUrl: string): Promise<ReleaseHeadResponse | null> {
  return new Promise((resolve) => {
    const request = net.request({ method: 'HEAD', url: assetUrl, redirect: 'manual' })
    let settled = false
    const settle = (response: ReleaseHeadResponse | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(response)
    }
    const timeout = setTimeout(() => {
      try {
        request.abort()
      } catch {
        // The request may already have been cancelled by Electron.
      }
      settle(null)
    }, FETCH_TIMEOUT_MS)

    request.on('redirect', (statusCode, _method, redirectUrl) => {
      // GitHub's redirect proves existence without fetching the signed storage URL.
      settle({ statusCode, redirectUrl })
    })
    request.on('response', (response) => settle({ statusCode: response.statusCode }))
    request.on('error', () => settle(null))
    try {
      request.end()
    } catch {
      settle(null)
    }
  })
}

async function getGitHubReleaseAssetReadiness(assetUrl: string): Promise<ReleaseReadiness> {
  const response = await requestGitHubReleaseHead(assetUrl)
  if (!response) {
    return 'unavailable'
  }
  const ready =
    response.redirectUrl !== undefined
      ? response.statusCode >= 300 && response.statusCode < 400
      : response.statusCode >= 200 && response.statusCode < 300
  return response.statusCode === 404 ? 'not-ready' : ready ? 'ready' : 'unavailable'
}

async function getReleaseAssetReadiness(tag: string, assetName: string): Promise<ReleaseReadiness> {
  const isRelativeAsset = !/^https?:\/\//i.test(assetName)
  const isGitHubReleaseAsset =
    process.platform === 'win32' &&
    (isRelativeAsset ||
      /^https:\/\/github\.com\/nplez1\/orca\/releases\/download\//i.test(assetName))
  const assetUrl = isRelativeAsset
    ? getReleaseAssetUrl(tag, assetName.split('/').findLast(Boolean) ?? assetName)
    : assetName
  if (isGitHubReleaseAsset) {
    return getGitHubReleaseAssetReadiness(assetUrl)
  }

  try {
    const res = await net.fetch(assetUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (res.status === 404) {
      return 'not-ready'
    }
    return res.ok ? 'ready' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Probe a tag's platform manifest and the assets it names: a feed entry may precede its upload. */
export async function getPlatformManifestReadiness(tag: string): Promise<ReleaseReadiness> {
  try {
    const manifestUrl = `${getReleaseDownloadUrl(tag)}/${getPlatformManifestName()}`
    const res = await net.fetch(manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 404) {
      return 'not-ready'
    }
    if (!res.ok) {
      return 'unavailable'
    }
    const manifestText = await res.text()
    let assetNames: string[]
    try {
      assetNames = getManifestAssetNames(manifestText)
    } catch {
      return 'not-ready'
    }
    if (assetNames.length === 0) {
      return 'not-ready'
    }
    const assetResults = await Promise.all(
      assetNames.map((assetName) => getReleaseAssetReadiness(tag, assetName))
    )
    return assetResults.includes('not-ready')
      ? 'not-ready'
      : assetResults.includes('unavailable')
        ? 'unavailable'
        : 'ready'
  } catch {
    return 'unavailable'
  }
}
