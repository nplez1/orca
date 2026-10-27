import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectCommands,
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

describe('TUI_AGENT_CONFIG', () => {
  it('resolves launchCmd and expectedProcess for every agent', () => {
    for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG)) {
      expect(config.launchCmd, agent).toBeTruthy()
      expect(config.expectedProcess, agent).toBeTruthy()
    }
  })

  it('defaults launchCmd and expectedProcess to detectCmd', () => {
    expect(TUI_AGENT_CONFIG.codex).toMatchObject({
      detectCmd: 'codex',
      launchCmd: 'codex',
      expectedProcess: 'codex'
    })
  })

  it('keeps explicit overrides where the launch line or process differs from the binary', () => {
    const overrides: Partial<Record<TuiAgent, Partial<(typeof TUI_AGENT_CONFIG)[TuiAgent]>>> = {
      'claude-agent-teams': { launchCmd: 'orca-np claude-teams', expectedProcess: 'claude' },
      kiro: { launchCmd: 'kiro-cli chat --tui', expectedProcess: 'kiro-cli' },
      'command-code': { launchCmd: 'command-code --trust' },
      hermes: { launchCmd: 'hermes --tui' },
      rovo: { detectCmd: 'acli', launchCmd: 'acli rovodev run', expectedProcess: 'acli' },
      muse: { launchCmd: 'muse --trust-workspace' }
    }
    for (const [agent, expected] of Object.entries(overrides)) {
      expect(TUI_AGENT_CONFIG[agent as TuiAgent]).toMatchObject(expected)
    }
  })

  it('applies the Orca NP overlay to Agent Teams without dropping upstream fields', () => {
    const teams = TUI_AGENT_CONFIG['claude-agent-teams']
    expect(getTuiAgentDetectCommands(teams)).toEqual([
      'orca-np',
      'orca-np-dev',
      'orca-dev',
      'orca-ide'
    ])
    expect(teams).toMatchObject({
      detectRequiredCommands: ['claude'],
      detectUnsupportedRuntimes: ['win32', 'wsl'],
      expectedProcess: 'claude'
    })
  })

  it('launches the local CLI locally and the relay shim on every remote platform', () => {
    const teams = TUI_AGENT_CONFIG['claude-agent-teams']
    expect(getTuiAgentLaunchCommand(teams, 'darwin')).toBe('orca-np claude-teams')
    expect(getTuiAgentLaunchCommand(teams, 'linux')).toBe('orca-np claude-teams')
    expect(getTuiAgentLaunchCommand(teams, 'win32')).toBe('orca-np.cmd claude-teams')
    const remote = { isRemote: true }
    expect(getTuiAgentLaunchCommand(teams, 'darwin', remote)).toBe('orca claude-teams')
    expect(getTuiAgentLaunchCommand(teams, 'linux', remote)).toBe('orca claude-teams')
    expect(getTuiAgentLaunchCommand(teams, 'win32', remote)).toBe('orca.cmd claude-teams')
    expect(getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.kiro, 'darwin', remote)).toBe(
      'kiro-cli chat --tui'
    )
  })
})
