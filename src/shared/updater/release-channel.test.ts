import { describe, expect, it } from 'vitest'
import {
  getPlatformUpdateManifestName,
  getReleaseNotesUrlForVersion,
  getReleaseRepoForChannel,
  hasInstallableArtifactForPlatform,
  parseHourlyVersionStamp,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'

describe('release channel', () => {
  // Upstream keeps hourly tags out of the main repo because its releases atom feed exposes only the
  // 10 newest entries, so 24 hourly tags a day would evict every stable/RC entry.
  // LOCAL(nplez1): this fork publishes a single stream, so the dev channels resolve to it too. They
  // are not offered in the picker, but a channel persisted by an older build still resolves here —
  // and pointing it at upstream's repo would replace this build with an official Orca.
  it('resolves every channel to this fork, which publishes one stream', () => {
    expect(getReleaseRepoForChannel('hourly')).toBe('nplez1/orca')
    expect(getReleaseRepoForChannel('daily')).toBe('nplez1/orca')
    expect(getReleaseRepoForChannel('adhoc')).toBe('nplez1/orca')
    expect(getReleaseRepoForChannel('stable')).toBe('nplez1/orca')
    expect(getReleaseRepoForChannel('rc')).toBe('nplez1/orca')
  })

  // Why: an hourly tag linked against the main repo 404s — the tag only exists
  // in the hourly repo.
  it('builds release-notes links against the repo that published the version', () => {
    expect(getReleaseNotesUrlForVersion('1.4.160-hourly.202607281400')).toBe(
      'https://github.com/nplez1/orca/releases/tag/v1.4.160-hourly.202607281400'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160-daily.202607281300')).toBe(
      'https://github.com/nplez1/orca/releases/tag/v1.4.160-daily.202607281300'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160')).toBe(
      'https://github.com/nplez1/orca/releases/tag/v1.4.160'
    )
    expect(getReleaseNotesUrlForVersion('v1.4.160-rc.3')).toBe(
      'https://github.com/nplez1/orca/releases/tag/v1.4.160-rc.3'
    )
    expect(getReleaseNotesUrlForVersion('1.4.160-adhoc.20260728140533')).toBe(
      'https://github.com/nplez1/orca/releases/tag/v1.4.160-adhoc.20260728140533'
    )
    expect(getReleaseNotesUrlForVersion(null)).toBe('https://github.com/nplez1/orca/releases')
  })

  it('names the manifest electron-updater reads for one platform and architecture', () => {
    expect(getPlatformUpdateManifestName('darwin', 'arm64')).toBe('latest-mac.yml')
    expect(getPlatformUpdateManifestName('darwin', 'x64')).toBe('latest-mac.yml')
    expect(getPlatformUpdateManifestName('win32', 'x64')).toBe('latest.yml')
    expect(getPlatformUpdateManifestName('linux', 'x64')).toBe('latest-linux.yml')
    expect(getPlatformUpdateManifestName('linux', 'arm64')).toBe('latest-linux-arm64.yml')
    expect(getPlatformUpdateManifestName('freebsd', 'x64')).toBeNull()
  })

  // Why one manifest and not either: this fork publishes Linux x64 only, so accepting
  // `latest-linux-arm64.yml` too offered arm64 users a release whose own manifest 404s — the picker
  // row looked installable and the download behind it could not exist.
  it('does not accept the other Linux architecture’s manifest', () => {
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux.yml'], 'x64')).toBe(true)
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux-arm64.yml'], 'x64')).toBe(
      false
    )
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux-arm64.yml'], 'arm64')).toBe(
      true
    )
    expect(hasInstallableArtifactForPlatform('linux', ['latest-linux.yml'], 'arm64')).toBe(false)
    expect(
      hasInstallableArtifactForPlatform(
        'linux',
        ['latest-linux.yml', 'latest-linux-arm64.yml'],
        'arm64'
      )
    ).toBe(true)
  })

  it('rejects impossible dates without rejecting leap day', () => {
    expect(parseHourlyVersionStamp('1.4.160-hourly.202602300000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202802290000')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    )
  })

  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual(null, 'adhoc')).toBe(true)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('stable', 'rc')).toBe(false)
  })

  it('sorts dev builds by their cut time across different base versions', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.207-adhoc.20260919025813'),
      build('1.4.206-adhoc.20260919173504')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.206-adhoc.20260919173504',
      '1.4.207-adhoc.20260919025813'
    ])
  })
})
