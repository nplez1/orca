import { describe, expect, it } from 'vitest'
import {
  installedAppExecutableCandidates,
  LEGACY_MAC_DAEMON_JOB_LABEL_PREFIX,
  MAC_DAEMON_JOB_LABEL_PREFIX,
  macDaemonJobLabelWith
} from './install-layout-names'

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
