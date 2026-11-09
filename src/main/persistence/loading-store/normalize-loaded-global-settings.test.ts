import { homedir } from 'node:os'
import { expect, it, describe, vi } from 'vitest'
import { resolveAntigravityChatAuthConfig } from '../../../shared/antigravity-chat-auth-config'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { prepareLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import { prepareLoadedProfileSettings } from './prepare-loaded-profile-settings'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { newChatPermissionModeForSettings } from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { resolveAgentPermission } from '../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { resolveTuiAgentLaunchArgs } from '../../../shared/agent-launch/choices/tui-agent-launch-defaults'

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

it('keeps existing Antigravity profiles personal and preserves explicit or malformed saved choices for their owner', () => {
  expect(resolveAntigravityChatAuthConfig(normalizeLegacyProfile({}).antigravityChatAuth)).toEqual({
    method: 'oauth-personal'
  })
  const enterprise = {
    method: 'oauth-business',
    gcpProject: 'enterprise-project',
    gcpLocation: 'us-central1'
  }
  expect(normalizeLegacyProfile({ antigravityChatAuth: enterprise }).antigravityChatAuth).toEqual(
    enterprise
  )
  const malformed = normalizeLegacyProfile({ antigravityChatAuth: null }).antigravityChatAuth
  expect(malformed).toBeNull()
  expect(() => resolveAntigravityChatAuthConfig(malformed)).toThrow('account settings')
})

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
  it.each([true, false])(
    'drops the Chat UI switch and both older keys from a saved profile (default view chat %s)',
    (chatDefaultView) => {
      const normalized = normalizeLegacyProfile({
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: false,
        openAgentTabsInChatByDefault: chatDefaultView
      })
      expect(normalized).not.toHaveProperty('experimentalNativeChat')
      expect(normalized).not.toHaveProperty('experimentalStructuredNativeChat')
      expect(normalized).not.toHaveProperty('openAgentTabsInChatByDefault')
    }
  )
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

describe('the new-chat permission setting', () => {
  it.each<{
    name: string
    saved: Partial<GlobalSettings>
    raw: string[]
    choices: string[]
    terminal: string[]
  }>([
    {
      name: 'mixed terminal permissions before the Chat seed exists',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: {
          claude: '--dangerously-skip-permissions --model sonnet',
          codex: '--approve-for-me --config tui.animations=false'
        }
      },
      raw: ['--model sonnet', '--config tui.animations=false'],
      choices: ['full-access', 'auto'],
      terminal: [
        '--dangerously-skip-permissions --model sonnet',
        '--approve-for-me --config tui.animations=false'
      ]
    },
    {
      name: 'explicit empty Arguments with saved Chat defaults',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: '', codex: '' },
        nativeChatPermissionMode: 'auto'
      },
      raw: ['', ''],
      choices: ['own', 'own'],
      terminal: ['', '']
    },
    {
      name: 'Claude plan text owned by the user',
      saved: {
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: '--permission-mode plan --model sonnet', codex: '' },
        nativeChatPermissionMode: 'accept-edits'
      },
      raw: ['--permission-mode plan --model sonnet', ''],
      choices: ['own', 'own'],
      terminal: ['--permission-mode plan --model sonnet', '']
    },
    {
      name: 'legacy yolo defaults before either migration',
      saved: { agentYoloDefaultsMigrated: false, agentDefaultArgs: {} },
      raw: ['', ''],
      choices: ['full-access', 'full-access'],
      terminal: ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox']
    }
  ])(
    'loads and reloads $name through the real profile pipeline',
    ({ saved, raw, choices, terminal }) => {
      const defaults = getDefaultPersistedState(homedir())
      const retiredChatSettings = {
        agentNativeChatPermissionModes: { claude: 'ask', codex: 'auto' }
      }
      const parsed: PersistedState = {
        ...defaults,
        settings: {
          ...defaults.settings,
          agentPermissionDefault: undefined,
          agentPermissionOverrides: undefined,
          nativeChatPermissionMode: undefined,
          ...retiredChatSettings,
          agentDefaultEnv: { claude: { QA_LOADER_NOTE: 'preserved' } },
          ...saved
        }
      }
      const needsSave = vi.fn()
      const profile = prepareLoadedProfileSettings(parsed, defaults, needsSave)
      const loaded = normalizeLoadedGlobalSettings(
        parsed,
        prepareLoadedTerminalSettings(parsed, needsSave),
        profile
      )
      expect(needsSave).toHaveBeenCalled()
      expect(loaded.agentYoloDefaultsMigrated).toBe(true)
      expect(loaded.agentPermissionDefault).toBeDefined()
      expect(
        (['claude', 'codex'] as const).map((agent) =>
          newChatPermissionModeForSettings(agent, loaded)
        )
      ).toEqual(choices)
      expect(loaded).not.toHaveProperty('agentNativeChatPermissionModes')
      expect(loaded.agentDefaultEnv?.claude).toEqual({ QA_LOADER_NOTE: 'preserved' })
      expect(
        (['claude', 'codex'] as const).map((agent) => loaded.agentDefaultArgs?.[agent])
      ).toEqual(raw)
      expect(
        (['claude', 'codex'] as const).map((agent) => resolveAgentPermission(agent, loaded).choice)
      ).toEqual(choices)
      expect(
        (['claude', 'codex'] as const).map((agent) => resolveTuiAgentLaunchArgs(agent, loaded))
      ).toEqual(terminal)
      const reloaded: PersistedState = { ...parsed, settings: JSON.parse(JSON.stringify(loaded)) }
      expect(
        normalizeLoadedGlobalSettings(
          reloaded,
          prepareLoadedTerminalSettings(reloaded, needsSave),
          prepareLoadedProfileSettings(reloaded, defaults, needsSave)
        )
      ).toEqual(loaded)
    }
  )
})

describe('scoped new-chat permission defaults', () => {
  it('retires old chat copies while terminal intent and existing chat choices survive', () => {
    const normalized = normalizeLegacyProfile({
      nativeChatPermissionMode: 'full-access',
      agentNativeChatPermissionModes: { codex: 'auto', claude: 'ask', omp: 'auto', unknown: 'auto' }
    })
    expect(normalized).not.toHaveProperty('agentNativeChatPermissionModes')
    expect(normalized.nativeChatPermissionMode).toBe('full-access')
  })
})

it('migrates a shipped split chat/terminal profile using terminal choices while retaining other saved data', () => {
  const normalized = normalizeLegacyProfile({
    agentPermissionDefault: undefined,
    agentPermissionOverrides: undefined,
    agentPermissionMigrated: false,
    agentDefaultArgs: { claude: '--model opus --permission-mode acceptEdits', codex: '' },
    nativeChatPermissionMode: 'ask',
    agentNativeChatPermissionModes: { claude: 'full-access', codex: 'auto' },
    nativeChatSessionOptions: {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }
    }
  })
  expect(normalized).not.toHaveProperty('agentNativeChatPermissionModes')
  expect(newChatPermissionModeForSettings('claude', normalized)).toBe('accept-edits')
  expect(newChatPermissionModeForSettings('codex', normalized)).toBe('own')
  expect(normalized.nativeChatPermissionMode).toBe('ask')
  expect(normalized.agentDefaultArgs?.claude).toBe('--model opus')
  expect(normalized.nativeChatSessionOptions?.claude).toEqual({
    model: 'opus',
    valuesByModel: { opus: { effort: 'high' } }
  })
})

describe('pre-#10561 shared terminal color overrides', () => {
  const overrides = { background: '#101010' }
  const legacy = { terminalColorOverridesSplit: undefined, terminalColorOverrides: overrides }

  it.each([
    { theme: 'system', terminalUseSeparateLightTheme: true },
    { theme: 'light', terminalUseSeparateLightTheme: true },
    { theme: 'system', terminalUseSeparateLightTheme: undefined }
  ])('keep painting both modes when the light slot could show them (%o)', (appearance) => {
    const normalized = normalizeLegacyProfile({ ...legacy, ...appearance })
    expect(normalized.terminalColorOverrides).toEqual(overrides)
    expect(normalized.terminalColorOverridesLight).toEqual(overrides)
    expect(normalized.terminalColorOverridesSplit).toBe(true)
  })

  it.each([
    { theme: 'dark', terminalUseSeparateLightTheme: true },
    { theme: 'light', terminalUseSeparateLightTheme: false }
  ])('stay on the dark slot otherwise (%o)', (appearance) => {
    const normalized = normalizeLegacyProfile({ ...legacy, ...appearance })
    expect(normalized.terminalColorOverrides).toEqual(overrides)
    expect(normalized.terminalColorOverridesLight).toBeUndefined()
  })

  it('never re-split once migrated, so a cleared light slot stays clear', () => {
    const normalized = normalizeLegacyProfile({
      terminalColorOverrides: overrides,
      theme: 'light',
      terminalUseSeparateLightTheme: true
    })
    expect(normalized.terminalColorOverridesLight).toBeUndefined()
  })
})

describe('terminal default shell', () => {
  it('trims a hand-edited value and treats whitespace-only as unset', () => {
    expect(
      normalizeLegacyProfile({ terminalDefaultShell: '  /bin/zsh  ' }).terminalDefaultShell
    ).toBe('/bin/zsh')
    expect(normalizeLegacyProfile({ terminalDefaultShell: '   ' }).terminalDefaultShell).toBe('')
  })
})

it('loads an existing profile without a terminal policy mirror and preserves its saved preferences', () => {
  const loaded = normalizeLegacyProfile({
    terminalFocusFollowsMouse: true,
    machineName: 'Build server'
  })
  expect(loaded.terminalFocusFollowsMouse).toBe(true)
  expect(loaded.machineName).toBe('Build server')
  expect(loaded).not.toHaveProperty('maxTerminals')
})
