import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORCA_APP_ID } from '../../src/shared/local-build-compatibility'
import {
  COMPUTER_USE_BUNDLE_ID,
  COMPUTER_USE_DISPLAY_NAME
} from './computer-use-bundle-identity.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

function source(path) {
  return readFileSync(join(projectDir, path), 'utf8')
}

function swiftSources() {
  const root = join(projectDir, 'native', 'computer-use-macos', 'Sources')
  return readdirSync(root, { recursive: true })
    .filter((entry) => typeof entry === 'string' && entry.endsWith('.swift'))
    .map((entry) => source(join('native', 'computer-use-macos', 'Sources', entry)))
}

describe('computer-use bundle identity', () => {
  it('keeps the helper inside the namespace the app itself ships under', () => {
    expect(COMPUTER_USE_BUNDLE_ID).toBe(`${ORCA_APP_ID}.computer-use`)
    expect(COMPUTER_USE_BUNDLE_ID.startsWith(`${ORCA_APP_ID}.`)).toBe(true)
    expect(COMPUTER_USE_DISPLAY_NAME.length).toBeGreaterThan(0)
  })

  it('builds the helper Info.plist from the shared identity rather than a second literal', () => {
    const script = source('config/scripts/build-computer-macos.mjs')

    // The env override stays, so a local build can still pick its own signing identity.
    expect(script).toContain('process.env.ORCA_COMPUTER_MACOS_BUNDLE_ID ?? COMPUTER_USE_BUNDLE_ID')
    expect(script).toContain('COMPUTER_USE_DISPLAY_NAME')
    expect(script).not.toMatch(/['"]com\.[a-zA-Z0-9.-]+\.orca[a-zA-Z0-9.-]*['"]/)
  })

  it('leaves no pre-rename bundle id in any helper source', () => {
    // Why: the rename to "Orca NP" missed this helper. Grants stayed anchored to the old id, so
    // macOS re-prompted for Accessibility and Screen Recording and nothing could reset the stale
    // rows. Scanning every source file catches the next missed one, however it is spelled.
    expect(swiftSources().join('\n')).not.toContain('com.stablyai.orca')
    for (const path of [
      'config/scripts/build-computer-macos.mjs',
      'config/scripts/computer-use-bundle-identity.mjs',
      'src/main/computer/macos-computer-use-permissions.ts'
    ]) {
      expect(source(path)).not.toContain('com.stablyai.orca')
    }
  })

  it('derives the peer trust list and queue labels from one Swift constant', () => {
    const identity = source(
      'native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/OrcaBundleIdentity.swift'
    )
    expect(identity).toContain('"com.nplez1.orca"')
    expect(identity).toContain('"\\(appId).computer-use"')

    const main = source('native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift')
    expect(main).toContain('OrcaBundleIdentity.isTrustedPeer(bundleId: bundleId)')

    for (const path of [
      'native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/PermissionStatusSnapshot.swift',
      'native/computer-use-macos/Sources/OrcaComputerUseMacOSCore/AuthenticatedConnectionHangupMonitor.swift'
    ]) {
      const labelSources = source(path)
      expect(labelSources).toContain('OrcaBundleIdentity.computerUseBundleId')
      expect(labelSources).not.toMatch(/label: "com\./)
    }
  })
})
