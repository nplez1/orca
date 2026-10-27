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
