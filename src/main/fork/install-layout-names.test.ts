import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installedAppExecutableCandidates,
  LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX,
  LINUX_APP_EXECUTABLE_NAME,
  MAC_APP_EXECUTABLE_NAME,
  MAC_DAEMON_JOB_LABEL_PREFIX,
  macDaemonJobLabelWith
} from './install-layout-names'

const PACKAGED_LAUNCHERS = {
  darwin: resolve(__dirname, '../../../resources/darwin/bin/orca'),
  linux: resolve(__dirname, '../../../resources/linux/bin/orca-ide')
}

describe('macDaemonJobLabelWith', () => {
  it('names this build, and keeps the pre-rename label the old builds wrote', () => {
    expect(MAC_DAEMON_JOB_LABEL_PREFIX).toBe('com.nplez1.orca.terminal')
    expect(LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX).toBe('com.stablyai.orca.terminal')
    expect(macDaemonJobLabelWith(MAC_DAEMON_JOB_LABEL_PREFIX, '/tmp/userData', 55)).toMatch(
      /^com\.nplez1\.orca\.terminal\.[0-9a-f]{16}\.v55$/
    )
    expect(macDaemonJobLabelWith(LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX, '/tmp/userData', 55)).toBe(
      macDaemonJobLabelWith(MAC_DAEMON_JOB_LABEL_PREFIX, '/tmp/userData', 55).replace(
        MAC_DAEMON_JOB_LABEL_PREFIX,
        LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX
      )
    )
  })
})

describe('installedAppExecutableCandidates', () => {
  it('resolves this build beside an official Orca on macOS', () => {
    expect(installedAppExecutableCandidates('darwin', '/Users/dev', {})).toEqual([
      '/Applications/Orca NP.app/Contents/MacOS/Orca NP',
      '/Users/dev/Applications/Orca NP.app/Contents/MacOS/Orca NP'
    ])
  })

  it('resolves the per-user and per-machine NSIS layouts on Windows', () => {
    expect(
      installedAppExecutableCandidates('win32', 'C:\\Users\\dev', {
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files'
      })
    ).toEqual([
      'C:\\Users\\dev\\AppData\\Local\\Programs\\orca-np\\Orca NP.exe',
      'C:\\Users\\dev\\AppData\\Local\\Programs\\orca\\Orca NP.exe',
      'C:\\Program Files\\orca-np\\Orca NP.exe'
    ])
  })

  it('skips a Windows root the environment does not name', () => {
    expect(installedAppExecutableCandidates('win32', 'C:\\Users\\dev', {})).toEqual([])
  })

  it('resolves only the packaged Linux payload, not the CLI shims on PATH', () => {
    expect(installedAppExecutableCandidates('linux', '/home/dev', {})).toEqual([
      '/opt/Orca NP/orca-np',
      '/opt/orca-np/orca-np'
    ])
  })

  // Why the shipped script and not the constant: a rename that misses the launcher leaves it
  // exec'ing an official Orca's bundle, which starts the other app's CLI in this build's session.
  it('names this build in the packaged launcher scripts', () => {
    const darwinLauncher = readFileSync(PACKAGED_LAUNCHERS.darwin, 'utf8')
    expect(darwinLauncher.match(/^ELECTRON="(.*)"$/m)?.[1]).toBe(
      `$CONTENTS/MacOS/${MAC_APP_EXECUTABLE_NAME}`
    )
    expect(darwinLauncher).not.toMatch(/MacOS\/Orca"/)

    const linuxLauncher = readFileSync(PACKAGED_LAUNCHERS.linux, 'utf8')
    expect(linuxLauncher.match(/^for candidate in (.*); do$/m)?.[1]).toContain(
      LINUX_APP_EXECUTABLE_NAME
    )
  })

  it('never names an official Orca install', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const candidates = installedAppExecutableCandidates(platform, '/home/dev', {
        LOCALAPPDATA: 'C:\\Local',
        ProgramFiles: 'C:\\Program Files'
      })
      expect(candidates.join('\n')).not.toMatch(/Orca\.app|Orca\.exe|orca-ide|[/\\]Orca[/\\]/)
    }
  })
})
