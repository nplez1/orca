import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'

// Simulates a profile created before the fields under test were persisted. A profile written
// before a field existed has no such key at all, which is the only shape that exercises the
// load-time derivation — seeding from today's defaults would carry the new value in and pass for
// the wrong reason.
function normalizeLegacyProfile(
  overrides: Record<string, unknown>,
  omit: readonly (keyof GlobalSettings)[] = [
    'experimentalActivity',
    'experimentalAgentDashboardPopout'
  ]
): PersistedState['settings'] {
  const defaults = getDefaultPersistedState(homedir())
  const settings: Partial<GlobalSettings> = { ...defaults.settings }
  for (const key of omit) {
    delete settings[key]
  }
  Object.assign(settings, overrides)
  const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
  const noop = (): void => {}
  const terminal = prepareLoadedTerminalSettings(parsed, noop)
  const profile = prepareLoadedProfileSettings(parsed, defaults, noop)
  return normalizeLoadedGlobalSettings(parsed, terminal, profile)
}

describe('retired Agents sidebar setting', () => {
  it('does not mark new profiles as migrated', () => {
    expect(normalizeLegacyProfile({}).agentsSidebarMigratedFromExperimental).toBe(false)
  })

  it('drops the old visibility setting while preserving migration metadata', () => {
    const normalized = normalizeLegacyProfile({
      experimentalActivity: true,
      showAgentsSidebar: false
    })
    expect('showAgentsSidebar' in normalized).toBe(false)
    expect(normalized.agentsSidebarMigratedFromExperimental).toBe(true)
  })
})

describe('retired managed servers experiment', () => {
  it('drops the stored toggle, since managed servers are the default SSH path', () => {
    expect('experimentalManagedServers' in normalizeLegacyProfile({})).toBe(false)
    expect(
      'experimentalManagedServers' in normalizeLegacyProfile({ experimentalManagedServers: true })
    ).toBe(false)
  })
})

describe('retired chat default selectors', () => {
  it('keeps Chat UI on while dropping both older keys from a saved profile', () => {
    const normalized = normalizeLegacyProfile({
      experimentalNativeChat: true,
      experimentalStructuredNativeChat: false,
      openAgentTabsInChatByDefault: false
    })
    expect(normalized.experimentalNativeChat).toBe(true)
    expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
    expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
  })
})

describe('structured chat shell environment settings', () => {
  it('keeps a valid saved list and an explicit opt-out', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: false,
      nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 'CODEX_LB_API_KEY']
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(false)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([
      'HTTPS_PROXY',
      'CODEX_LB_API_KEY'
    ])
  })

  it('degrades a malformed hand-edited value to the defaults instead of failing a chat', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatInheritShellEnvironment: 'no',
      nativeChatShellEnvironmentVariables: 'HTTPS_PROXY, CODEX_LB_API_KEY'
    })
    expect(normalized.nativeChatInheritShellEnvironment).toBe(true)
    expect(normalized.nativeChatShellEnvironmentVariables).toEqual([])
  })

  it('drops non-string and invalid entries from a saved list', () => {
    expect(
      normalizeLegacyProfile({
        nativeChatShellEnvironmentVariables: ['HTTPS_PROXY', 7, null, 'not valid', 'HTTPS_PROXY']
      }).nativeChatShellEnvironmentVariables
    ).toEqual(['HTTPS_PROXY'])
  })
})

describe('machine name setting', () => {
  it('trims persisted names and defaults missing legacy values to automatic detection', () => {
    expect(normalizeLegacyProfile({ machineName: '  Build server  ' }).machineName).toBe(
      'Build server'
    )
    expect(normalizeLegacyProfile({ machineName: undefined }).machineName).toBe('')
    expect(normalizeLegacyProfile({ machineName: 'x'.repeat(300) }).machineName).toHaveLength(255)
  })
})

describe('chat appearance settings', () => {
  it('normalizes old and malformed profiles on load', () => {
    expect(normalizeLegacyProfile({}).nativeChatAppearance).toBeUndefined()
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 40, codeFontSize: 1, width: 'wide' }
      }).nativeChatAppearance
    ).toEqual({ fontSize: 20, codeFontSize: 10, width: 'wide' })
    expect(
      normalizeLegacyProfile({
        nativeChatAppearance: { fontSize: 14, codeFontSize: 12, width: 'comfortable' }
      }).nativeChatAppearance
    ).toBeUndefined()
  })
})

describe('worktree layout mode for profiles written before it existed', () => {
  it('keeps an explicit flat opt-out flat instead of taking the new default', () => {
    // Why: `nestWorkspaces: false` was a deliberate choice. The mode default is project-folder,
    // and the persisted settings are spread over the defaults, so without this derivation the
    // new default would silently move those users into the layout they turned off.
    const settings = normalizeLegacyProfile({ nestWorkspaces: false }, ['worktreeLayoutMode'])

    expect(settings.worktreeLayoutMode).toBe('flat')
  })

  it('reads an explicit nested opt-in as repo-nested', () => {
    const settings = normalizeLegacyProfile({ nestWorkspaces: true }, ['worktreeLayoutMode'])

    expect(settings.worktreeLayoutMode).toBe('repo-nested')
  })

  it('lets a persisted mode win over the legacy boolean', () => {
    const settings = normalizeLegacyProfile(
      { nestWorkspaces: false, worktreeLayoutMode: 'project-folder' },
      ['worktreeLayoutMode']
    )

    expect(settings.worktreeLayoutMode).toBe('project-folder')
  })

  it('gives a fresh install the new default', () => {
    // A first run has no settings file, so nothing overrides the default.
    const defaults = getDefaultPersistedState(homedir())
    const settings: Partial<GlobalSettings> = { ...defaults.settings }
    delete settings.worktreeLayoutMode
    const parsed: PersistedState = { ...defaults, settings: settings as GlobalSettings }
    const noop = (): void => {}
    const terminal = prepareLoadedTerminalSettings(parsed, noop)
    const profile = prepareLoadedProfileSettings(parsed, defaults, noop)

    // An existing-but-modeless profile derives from the boolean, which is the same answer the
    // default gives while `nestWorkspaces` defaults to true.
    expect(normalizeLoadedGlobalSettings(parsed, terminal, profile).worktreeLayoutMode).toBe(
      'repo-nested'
    )
    // The untouched default object is what a genuinely new install starts from.
    expect(defaults.settings.worktreeLayoutMode).toBe('project-folder')
  })
})
