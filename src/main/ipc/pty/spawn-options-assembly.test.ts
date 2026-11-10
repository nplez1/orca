import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assemblePtySpawnLaunchOptions,
  type PtySpawnLaunchOptionsInput
} from './spawn-options-assembly'
import type { AgentWorkspaceTrustDecision } from '../../../shared/agent-launch/permissions/agent-workspace-trust-decision'
import type { GlobalSettings } from '../../../shared/global-settings-types'

// Why: an agent with a trust preset writes one into the agent's home, and these tests must not touch
// the developer's real one.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'orca-spawn-trust-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})
afterEach(() => vi.unstubAllEnvs())

function spawnInput(input: {
  launchAgent?: string
  launchCommand?: string
  cwd?: string
  repoDecision?: AgentWorkspaceTrustDecision
  skipAgentWorkspaceTrust?: boolean
  worktreeId?: string
  preAdoptedStablePane?: boolean
}): PtySpawnLaunchOptionsInput {
  return {
    args: {
      cols: 120,
      rows: 30,
      launchAgent: input.launchAgent ?? 'pi',
      command: input.launchCommand ?? "pi 'fix the bug'",
      worktreeId: input.worktreeId ?? 'repo-1::/srv/app',
      ...(input.skipAgentWorkspaceTrust ? { skipAgentWorkspaceTrust: true } : {})
    },
    env: {},
    envToDelete: [],
    launchCommand: input.launchCommand ?? "pi 'fix the bug'",
    cwd: input.cwd ?? '/srv/app',
    isDaemonHostSpawn: false,
    preAdoptedStablePane: input.preAdoptedStablePane ?? false,
    isNewSession: true,
    codexRuntime: 'host',
    expectedWslDistro: null,
    requestedAgentTeamsPath: undefined,
    selectedCodexHomePath: null,
    shellOverride: undefined,
    paneKey: null,
    sessionId: undefined,
    spawnIntent: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn path reads only this one setting.
    getSettings: () => ({ agentWorkspaceTrustEnabled: true }) as GlobalSettings,
    store: {
      getFolderWorkspace: () => undefined,
      getRepo: (repoId) =>
        repoId === 'repo-1' && input.repoDecision
          ? { agentWorkspaceTrust: input.repoDecision }
          : undefined
    },
    claudeAuth: null
  }
}

describe('pi launch command carries its project-trust answer', () => {
  it('adds --approve to the spawned command only', async () => {
    const launch = await assemblePtySpawnLaunchOptions(spawnInput({}))
    expect(launch.spawnOptions.command).toBe("pi --approve 'fix the bug'")
    // Why: the caller keeps this one as the session's command, so it must stay resumable as authored.
    expect(launch.launchCommand).toBe("pi 'fix the bug'")
  })

  it('leaves the command alone when the agent is the one asking', async () => {
    const asked = await assemblePtySpawnLaunchOptions(spawnInput({ repoDecision: 'agent-asks' }))
    expect(asked.spawnOptions.command).toBe("pi 'fix the bug'")
    const skipped = await assemblePtySpawnLaunchOptions(
      spawnInput({ skipAgentWorkspaceTrust: true })
    )
    expect(skipped.spawnOptions.command).toBe("pi 'fix the bug'")
  })

  it('does not answer for a folder the user opened', async () => {
    const folder = await assemblePtySpawnLaunchOptions(spawnInput({ cwd: '/Users/me/notes' }))
    expect(folder.spawnOptions.command).toBe("pi 'fix the bug'")
  })

  it('keeps the flag out of a re-adopted pane', async () => {
    const adopted = await assemblePtySpawnLaunchOptions(spawnInput({ preAdoptedStablePane: true }))
    expect(adopted.spawnOptions.command).toBe("pi 'fix the bug'")
  })

  it('never asks Orca to pre-write a pi trust artifact', async () => {
    const launch = await assemblePtySpawnLaunchOptions(spawnInput({}))
    expect(launch.spawnOptions.agentWorkspaceTrust).toBeUndefined()
  })

  it('says nothing extra for an agent without trust args', async () => {
    const claude = await assemblePtySpawnLaunchOptions(
      spawnInput({ launchAgent: 'claude', launchCommand: "claude 'fix the bug'" })
    )
    expect(claude.spawnOptions.command).toBe("claude 'fix the bug'")
  })
})
