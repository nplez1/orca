import { getPlatformUpdateManifestName } from '../shared/release-channel'

export const RELEASES_REPO = 'nplez1/orca'
const RELEASES_DOWNLOAD_BASE = `https://github.com/${RELEASES_REPO}/releases/download`

export const FETCH_TIMEOUT_MS = 5000

export function getReleaseDownloadUrl(tag: string): string {
  return `${RELEASES_DOWNLOAD_BASE}/${encodeURIComponent(tag)}`
}

/** The manifest electron-updater reads on this platform and architecture. */
export function getPlatformManifestName(): string {
  return getPlatformUpdateManifestName(process.platform, process.arch) ?? 'latest.yml'
}

export function getReleaseAssetUrl(tag: string, assetName: string): string {
  return `${getReleaseDownloadUrl(tag)}/${encodeURIComponent(assetName)}`
}
