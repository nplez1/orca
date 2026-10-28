import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectCommands,
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from './tui-agent-config'

// Why this file survives upstream retiring its tui-agent-config suite (#33770): these cases pin the
// Orca NP overlay, which upstream cannot test and which a silent profile change would break.
describe('Orca NP overlay on the TUI agent table', () => {
  const teams = TUI_AGENT_CONFIG['claude-agent-teams']

  it('applies the overlay to Agent Teams without dropping upstream fields', () => {
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
