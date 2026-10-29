import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLinuxElectronBuilderArgs } from './build-linux-local.mjs'
import { APP_DISPLAY_NAME } from '../../src/shared/app-display-name'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const release = require('../electron-builder.config.cjs')
const np = require('../electron-builder.np.config.cjs')

function differingPaths(left, right, path = '') {
  if (Object.is(left, right)) {
    return []
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return [path]
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].flatMap((key) =>
    differingPaths(left[key], right[key], path ? `${path}.${key}` : key)
  )
}

describe('Orca NP electron-builder overlay', () => {
  // Why: anything else differing means the overlay forked behaviour, not just names.
  it('changes only the identity fields of the release config', () => {
    const paths = new Set(differingPaths(release, np).map((path) => path.replace(/\.\d+/g, '[]')))
    expect([...paths].sort()).toEqual(
      [
        'appId',
        'deb.artifactName',
        'deb.packageName',
        // `name` is the only field the overlay adds; a channel build's `version` is carried through.
        release.extraMetadata ? 'extraMetadata.name' : 'extraMetadata',
        'linux.executableName',
        'mac.artifactName',
        'productName',
        'protocols[].name',
        'rpm.artifactName',
        'rpm.packageName',
        'win.executableName',
        'win.extraResources[].from',
        'win.extraResources[].to',
        'win.signtoolOptions.publisherName',
        'win.verifyUpdateCodeSignature'
      ].sort()
    )
  })

  // Why: NSIS derives the install directory and electron-builder the updater cache from the package
  // name, so leaving upstream's `orca` overwrites an official install's app.asar.
  it('installs beside an official Orca instead of into its directory', () => {
    expect(np.extraMetadata.name).toBe('orca-np')
    // A dev-channel build stages its own version here; taking it away ships the wrong one.
    expect(np.extraMetadata.version).toBe(release.extraMetadata?.version)
  })

  // Why: electron-builder writes a mac zip's blockmap beside the file it archived, then publishes
  // the zip under a GitHub-safe name — swapping spaces for dashes only in the published copy. With
  // "Orca NP" in the product name the zip went out as `Orca-NP-…-mac.zip` and its blockmap as
  // `Orca.NP-…-mac.zip.blockmap`, so the updater's `<zip url>.blockmap` request 404'd and every
  // macOS update re-downloaded the whole app instead of a diff.
  it('names the mac zip so the blockmap the updater asks for exists', () => {
    const artifactName = np.mac.artifactName
    expect(artifactName).toBe('Orca-NP-${version}-${arch}-mac.${ext}')

    const expand = (arch) =>
      artifactName
        .replaceAll('${version}', '1.4.214-np.41')
        .replaceAll('${arch}', arch)
        .replaceAll('${ext}', 'zip')

    for (const arch of ['x64', 'arm64']) {
      const zip = expand(arch)
      // GitHub rejects the space, so electron-builder renames a name that contains one — which is
      // what split the zip from its blockmap. Nothing to rename means nothing to split.
      expect(zip).toMatch(/^[0-9A-Za-z._-]+$/)
      expect(`${zip}.blockmap`).toMatch(/^[0-9A-Za-z._-]+$/)
      expect(zip).toContain(`-${arch}-mac.zip`)
    }

    // The dmg keeps upstream's name: `dmg.artifactName` is target-specific and wins over mac's.
    expect(np.dmg.artifactName).toBe(release.dmg.artifactName)
  })

  it('drives the packaged product name from the shared display name', () => {
    // The config is CommonJS and cannot import the TypeScript constant, so this is what keeps the
    // bundle name (macOS app menu, Dock, install path) from drifting away from the window's.
    expect(np.productName).toBe(APP_DISPLAY_NAME)
    expect(np.win.executableName).toBe(APP_DISPLAY_NAME)
  })

  it('keeps the orca:// scheme so official clients and share links still open this app', () => {
    expect(np.appId).toBe('com.nplez1.orca')
    expect(np.protocols).toEqual([{ name: APP_DISPLAY_NAME, schemes: ['orca'] }])
  })

  it('ships the Windows CLI under this fork name, from sources that exist', () => {
    const [shim, launcher, ...rest] = np.win.extraResources.filter((entry) =>
      /^bin\/orca(-np)?\.(cmd|exe)$/.test(entry.to)
    )
    expect(rest).toEqual([])
    expect(shim.to).toMatch(/^bin\/orca-np\.cmd$/)
    expect(shim.from).toMatch(/^resources\/win32\/bin\/orca-np\.cmd$/)
    expect(existsSync(join(REPO_ROOT, shim.from))).toBe(true)
    // The launcher is built under upstream's name; only the packaged copy is renamed.
    expect(launcher).toEqual({
      from: 'native/windows-cli-launcher/.build/orca.exe',
      to: 'bin/orca-np.exe'
    })
  })

  // Why: this fork ships Windows unsigned, and electron-updater rejects an installer whose
  // signature does not match the installed app's publisherName.
  it('accepts its own unsigned Windows installers', () => {
    expect(np.win.signtoolOptions).not.toHaveProperty('publisherName')
    expect(np.win.signtoolOptions.sign).toBe(release.win.signtoolOptions.sign)
    expect(np.win.verifyUpdateCodeSignature).toBe(false)
  })

  it('names the Linux packages after this build so an official install is not replaced', () => {
    expect(np.deb).toMatchObject({
      packageName: 'orca-np',
      artifactName: 'orca-np_${version}_${arch}.${ext}'
    })
    expect(np.rpm).toMatchObject({
      packageName: 'orca-np',
      artifactName: 'orca-np-${version}.${arch}.${ext}'
    })
  })

  // Why: deb/rpm payload paths come from linux.executableName, so upstream's `orca-ide` there ships
  // the desktop entry, icons and mime package an official `orca-ide` package already owns.
  it('ships the Linux payload under file names no official package owns', () => {
    expect(np.linux.executableName).toBe('orca-np')
    // Everything else in the Linux leg stays upstream's.
    expect({ ...np.linux, executableName: release.linux.executableName }).toEqual(release.linux)
    // The in-bundle CLI launcher keeps its own name; it is a different file from the executable.
    expect(np.linux.extraResources).toEqual(release.linux.extraResources)
  })

  // Why: a sync that takes upstream's side of a build line would silently ship Orca's identity.
  it('is the config every Orca NP build entry point packages with', () => {
    const sources = [
      '.github/workflows/fork-release.yml',
      'config/scripts/build-mac-local.mjs',
      'package.json'
    ].map((path) => readFileSync(join(REPO_ROOT, path), 'utf8'))
    for (const source of sources) {
      expect(source).not.toContain('electron-builder.config.cjs')
    }
    const { scripts } = JSON.parse(sources[2])
    for (const name of ['build:unpack', 'build:win', 'build:mac:release']) {
      expect(scripts[name]).toContain('--config config/electron-builder.np.config.cjs')
    }
    expect(buildLinuxElectronBuilderArgs('x64')).toContain('config/electron-builder.np.config.cjs')
  })
})
