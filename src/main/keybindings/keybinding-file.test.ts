import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrateLegacyKeybindings,
  readKeybindingFile,
  writeKeybindingOverride,
  getUserKeybindingsPath
} from './keybinding-file'
import { getEffectiveKeybindingsForAction } from '../../shared/keybindings/effective'

describe('keybinding-file', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-keybindings-'))
    filePath = join(dir, 'keybindings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('roundtrips old arrays, new claims, explicit conflicts, masks/reset and pruning', () => {
    const toggle = 'terminal.toggleNativeChat'
    const navigation = 'worktree.navigateDown'
    const aliases = ['Mod+Shift+J', 'Mod+Alt+Y']
    const seed = (value: unknown) => writeFileSync(filePath, JSON.stringify(value))
    const effective = () =>
      getEffectiveKeybindingsForAction(
        toggle,
        'darwin',
        readKeybindingFile(filePath, 'darwin').overrides
      )
    writeKeybindingOverride(filePath, 'darwin', navigation, aliases)
    expect(effective()).toEqual([])
    seed({ keybindings: { [navigation]: aliases } })
    expect(readKeybindingFile(filePath, 'darwin').overrides).toEqual({ [navigation]: aliases })
    writeKeybindingOverride(filePath, 'darwin', navigation, [])
    expect(effective()).toEqual(['Mod+Shift+J'])
    writeKeybindingOverride(filePath, 'darwin', toggle, [])
    expect(effective()).toEqual([])
    writeKeybindingOverride(filePath, 'darwin', toggle, null)
    expect(effective()).toEqual(['Mod+Shift+J'])
    writeKeybindingOverride(filePath, 'darwin', navigation, null)
    expect(effective()).toEqual([])
    expect(() => writeKeybindingOverride(filePath, 'darwin', toggle, aliases)).toThrow('conflicts')
    seed({
      version: 1,
      keybindings: { [navigation]: ['Mod+Alt+Y'], [toggle]: ['Mod+Alt+Y'] },
      platforms: { darwin: { [navigation]: [] } }
    })
    const unchanged = readFileSync(filePath, 'utf8')
    expect(() => writeKeybindingOverride(filePath, 'darwin', navigation, null)).toThrow('conflicts')
    expect(readFileSync(filePath, 'utf8')).toBe(unchanged)
    seed({ keybindings: { [navigation]: ['Mod+Shift+J', 'Mod+P'] } })
    expect(readKeybindingFile(filePath, 'darwin').overrides).toEqual({})
    expect(effective()).toEqual(['Mod+Shift+J'])
    seed({ keybindings: { 'worktree.palette': aliases } })
    expect(
      writeKeybindingOverride(filePath, 'win32', 'worktree.palette', aliases).overrides[
        'worktree.palette'
      ]
    ).toEqual(aliases)
    expect(
      getEffectiveKeybindingsForAction(
        toggle,
        'win32',
        readKeybindingFile(filePath, 'win32').overrides
      )
    ).toEqual(['Mod+Shift+F11', 'Mod+Shift+J'])
  })

  it('resolves the user-facing keybindings path under ~/.orca-np', () => {
    expect(getUserKeybindingsPath('/home/test')).toBe(
      join('/home/test', '.orca-np', 'keybindings.json')
    )
  })

  it('returns an empty snapshot when the file does not exist', () => {
    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: false,
      platform: 'linux',
      overrides: {},
      diagnostics: []
    })
  })

  it('parses common and platform-specific overrides', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: {
          'worktree.quickOpen': 'Mod+Shift+P',
          'view.tasks': null
        },
        platforms: {
          linux: {
            'terminal.paste': ['Ctrl+Shift+V', 'Shift+Insert'],
            'terminal.search': 'Ctrl+Shift+F'
          },
          darwin: {
            'terminal.search': 'Mod+F'
          }
        }
      }),
      'utf8'
    )

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: true,
      overrides: {
        'worktree.quickOpen': ['Mod+Shift+P'],
        'view.tasks': [],
        'terminal.paste': ['Ctrl+Shift+V', 'Shift+Insert'],
        'terminal.search': ['Ctrl+Shift+F']
      },
      diagnostics: []
    })
  })

  it('accepts bare keys for actions that explicitly opt in', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          'fileExplorer.delete': 'Delete'
        }
      }),
      'utf8'
    )

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      overrides: {
        'fileExplorer.delete': ['Delete']
      },
      diagnostics: []
    })
  })

  it('preserves valid plugin overrides while rejecting malformed plugin action IDs', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          'plugin:samples.tasks/open': 'Mod+Shift+T',
          'plugin:tasks/open': 'Mod+Alt+T'
        }
      }),
      'utf8'
    )

    const snapshot = readKeybindingFile(filePath, 'linux')
    expect(snapshot.overrides).toEqual({
      'plugin:samples.tasks/open': ['Mod+Shift+T']
    })
    expect(snapshot.diagnostics).toMatchObject([
      { severity: 'warning', actionId: 'plugin:tasks/open' }
    ])

    writeKeybindingOverride(filePath, 'linux', 'plugin:samples.tasks/open', [])
    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({
      'plugin:samples.tasks/open': []
    })
  })

  it('ignores invalid, unknown, and conflicting manual edits', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          unknownAction: 'Ctrl+Alt+U',
          'terminal.search': 'not-a-keybinding',
          'view.tasks': 'Mod+P'
        }
      }),
      'utf8'
    )

    const snapshot = readKeybindingFile(filePath, 'linux')

    expect(snapshot.overrides).toEqual({})
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      'warning',
      'error',
      'error'
    ])
    expect(snapshot.diagnostics[1]).toMatchObject({
      message:
        'Shortcut for "terminal.search" was ignored: Use a shortcut like Ctrl+Shift+P or Cmd+K.',
      code: 'shortcutIgnored',
      params: { actionId: 'terminal.search' },
      reasonCode: 'invalidFormat'
    })
  })

  it('keeps the English read failure and codes its nested reason', () => {
    writeFileSync(filePath, '[]', 'utf8')
    expect(readKeybindingFile(filePath, 'linux').diagnostics).toEqual([
      {
        severity: 'error',
        message: 'Could not read keybindings file: Keybindings file must contain a JSON object.',
        code: 'readFailed',
        params: { reason: 'Keybindings file must contain a JSON object.' },
        reasonCode: 'fileNotObject'
      }
    ])
  })

  it('writes active-platform overrides while preserving other platforms', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: {
          'worktree.quickOpen': 'Mod+Shift+P'
        },
        platforms: {
          darwin: {
            'terminal.search': 'Mod+F'
          }
        }
      }),
      'utf8'
    )

    writeKeybindingOverride(filePath, 'linux', 'terminal.search', ['Ctrl+Shift+F'])

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as {
      keybindings: Record<string, unknown>
      platforms: Record<string, Record<string, unknown>>
    }
    expect(written.keybindings['worktree.quickOpen']).toBe('Mod+Shift+P')
    expect(written.platforms.darwin['terminal.search']).toBe('Mod+F')
    expect(written.platforms.linux['terminal.search']).toEqual(['Ctrl+Shift+F'])
  })

  it('migrates legacy settings once when no file exists', () => {
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+T'] })
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+X'] })

    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({
      'view.tasks': ['Ctrl+Alt+T']
    })
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'does not reimport a manually deleted shortcut on %s',
    (platform) => {
      migrateLegacyKeybindings(filePath, platform, { 'view.tasks': ['Ctrl+Alt+T'] })
      const document: { platforms: Record<string, Record<string, unknown>> } = JSON.parse(
        readFileSync(filePath, 'utf8')
      )
      delete document.platforms[platform]['view.tasks']
      writeFileSync(filePath, JSON.stringify(document))

      migrateLegacyKeybindings(filePath, platform, { 'view.tasks': ['Ctrl+Alt+T'] })

      expect(readKeybindingFile(filePath, platform).overrides).toEqual({})
    }
  )
})
