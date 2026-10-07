import { describe, expect, it } from 'vitest'
import {
  findUpstreamIdentityLines,
  isPolicedTestPath,
  isTestFile
} from './check-upstream-identity-literals.mjs'

describe('findUpstreamIdentityLines', () => {
  it('flags a feed URL asserted against upstream', () => {
    expect(
      findUpstreamIdentityLines(
        "expect(releaseUrl()).toBe('https://github.com/stablyai/orca/releases/download/x/y')\n"
      )
    ).toEqual([
      {
        line: 1,
        text: "expect(releaseUrl()).toBe('https://github.com/stablyai/orca/releases/download/x/y')"
      }
    ])
  })

  it('leaves the fork repository name alone', () => {
    expect(
      findUpstreamIdentityLines("expect(releaseUrl()).toContain('github.com/nplez1/orca')\n")
    ).toEqual([])
  })

  // Naming upstream as fixture data is legitimate; only the release feed's identity is the
  // fork's to own, and flagging the rest would make this check a false-failure source.
  it('leaves upstream named as fixture data alone', () => {
    expect(
      findUpstreamIdentityLines(
        "const label = 'stablyai/orca'\nconst url = 'https://github.com/stablyai/orca/pull/2049'\n"
      )
    ).toEqual([])
  })

  // Quoting upstream as fixture data is legitimate; the marker says so on the line it explains.
  it('honours the marker on the line and on the line above it', () => {
    expect(
      findUpstreamIdentityLines(
        "const feed = 'https://github.com/stablyai/orca/releases' // upstream-identity-ok: fixture\n"
      )
    ).toEqual([])
    expect(
      findUpstreamIdentityLines(
        "// upstream-identity-ok: asserts the upgrade path away from upstream\nconst feed = 'https://github.com/stablyai/orca/releases'\n"
      )
    ).toEqual([])
  })

  it('reports every offending line with its number', () => {
    expect(
      findUpstreamIdentityLines(
        "const a = 'x'\nconst b = 'stablyai/orca/releases/tag/v1'\nconst c = 'stablyai/orca/releases.atom'\n"
      )
    ).toEqual([
      { line: 2, text: "const b = 'stablyai/orca/releases/tag/v1'" },
      { line: 3, text: "const c = 'stablyai/orca/releases.atom'" }
    ])
  })
})

describe('isTestFile', () => {
  it('covers the test extensions this repo uses', () => {
    expect(isTestFile('src/a/b.test.ts')).toBe(true)
    expect(isTestFile('src/a/b.test.tsx')).toBe(true)
    expect(isTestFile('config/scripts/x.test.mjs')).toBe(true)
    expect(isTestFile('mobile/x.spec.ts')).toBe(true)
  })

  // The rule is scoped to product tests: release tooling reads upstream's latest release, and the
  // mobile APK source queries upstream deliberately. Policing those would be noise.
  it('policies product tests and leaves the out-of-scope surfaces alone', () => {
    expect(isPolicedTestPath('src/main/updater-agent-state-rules-release.test.ts')).toBe(true)
    expect(isPolicedTestPath('config/scripts/create-draft-release.test.mjs')).toBe(false)
    expect(isPolicedTestPath('mobile/src/app-update/app-update-sources.test.ts')).toBe(false)
    expect(isPolicedTestPath('src/main/thing.ts')).toBe(false)
  })

  it('ignores source, fixtures and snapshots', () => {
    expect(isTestFile('src/a/b.ts')).toBe(false)
    expect(isTestFile('src/a/b.test-fixtures.ts')).toBe(false)
    expect(isTestFile('docs/reference/x.md')).toBe(false)
  })
})
