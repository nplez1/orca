import { describe, expect, it } from 'vitest'
import type { AgentWorkspaceTrustDecision } from '../../../shared/agent-launch/permissions/agent-workspace-trust-decision'
import type { AgentTrustSpawnFields } from './agent-workspace-trust'
import {
  applyAgentWorkspaceTrustToSpawn,
  resolveAgentWorkspaceTrustLaunchArgs
} from './agent-workspace-trust-spawn'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

// An SSH launch only forwards the request to the relay, so no local config is written.
async function sshTrustRequest(input: {
  worktreeId: string
  globalEnabled?: boolean
  repoDecision?: AgentWorkspaceTrustDecision
  skipForThisLaunch?: boolean
}): Promise<AgentTrustSpawnFields> {
  const spawnOptions: AgentTrustSpawnFields = {}
  await applyAgentWorkspaceTrustToSpawn({
    launchAgent: 'claude',
    skipForThisLaunch: input.skipForThisLaunch,
    worktreeId: input.worktreeId,
    cwd: '/srv/app',
    store: {
      getFolderWorkspace: () => ({ folderPath: '/srv/folder' }),
      getRepo: (repoId) =>
        repoId === 'repo-1' && input.repoDecision
          ? { agentWorkspaceTrust: input.repoDecision }
          : undefined
    },
    isFreshLaunch: true,
    settings: { agentWorkspaceTrustEnabled: input.globalEnabled ?? true },
    env: {},
    claudeAuth: null,
    wslDistro: null,
    connectionId: 'ssh-1',
    spawnOptions
  })
  return spawnOptions
}

describe('agent folder trust follows the repo decision', () => {
  it('pre-trusts a repo whose decision is pre-trust', async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', repoDecision: 'pre-trust' })
    ).toEqual({ agentWorkspaceTrust: { workspacePath: '/srv/app' } })
  })

  it('leaves the folder untrusted when the repo lets agents ask', async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', repoDecision: 'agent-asks' })
    ).toEqual({})
  })

  it('never pre-trusts when folder trust is off globally', async () => {
    expect(
      await sshTrustRequest({
        worktreeId: 'repo-1::/srv/app',
        globalEnabled: false,
        repoDecision: 'pre-trust'
      })
    ).toEqual({})
  })

  it("honours this launch's let-agents-ask answer even when the repo has none stored", async () => {
    expect(
      await sshTrustRequest({ worktreeId: 'repo-1::/srv/app', skipForThisLaunch: true })
    ).toEqual({})
  })
})

function trustLaunchArgs(input: {
  launchAgent?: string
  worktreeId?: string
  cwd?: string
  globalEnabled?: boolean
  repoDecision?: AgentWorkspaceTrustDecision
  skipForThisLaunch?: boolean
  isFreshLaunch?: boolean
  folderPath?: string
}): readonly string[] {
  return resolveAgentWorkspaceTrustLaunchArgs({
    launchAgent: input.launchAgent ?? 'pi',
    skipForThisLaunch: input.skipForThisLaunch,
    worktreeId: input.worktreeId ?? 'repo-1::/srv/app',
    cwd: input.cwd ?? '/srv/app',
    store: {
      getFolderWorkspace: () => (input.folderPath ? { folderPath: input.folderPath } : undefined),
      getRepo: (repoId) =>
        repoId === 'repo-1' && input.repoDecision
          ? { agentWorkspaceTrust: input.repoDecision }
          : undefined
    },
    isFreshLaunch: input.isFreshLaunch ?? true,
    settings: { agentWorkspaceTrustEnabled: input.globalEnabled ?? true }
  })
}

describe('agent trust launch args', () => {
  it('settles the prompt for a fresh pi launch into a pre-trusted worktree', () => {
    expect(trustLaunchArgs({})).toEqual(['--approve'])
  })

  it('keeps the agent asking when the repo says so, globally or for this launch', () => {
    expect(trustLaunchArgs({ repoDecision: 'agent-asks' })).toEqual([])
    expect(trustLaunchArgs({ globalEnabled: false })).toEqual([])
    expect(trustLaunchArgs({ skipForThisLaunch: true })).toEqual([])
    expect(trustLaunchArgs({ isFreshLaunch: false })).toEqual([])
  })

  it('stays out of a folder the user opened rather than Orca creating it', () => {
    expect(
      trustLaunchArgs({
        worktreeId: 'folder:folder-1',
        folderPath: '/Users/me/notes',
        cwd: '/Users/me/notes'
      })
    ).toEqual([])
    expect(
      trustLaunchArgs({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID, cwd: '/Users/me/notes' })
    ).toEqual([])
  })

  it('follows the agent only while it starts inside the worktree', () => {
    expect(trustLaunchArgs({ cwd: '/srv/app/packages/api' })).toEqual(['--approve'])
    expect(trustLaunchArgs({ cwd: '/srv/other' })).toEqual([])
    expect(trustLaunchArgs({ cwd: '/srv/app-evil' })).toEqual([])
  })

  it('has nothing to add for an agent with no trust args', () => {
    expect(trustLaunchArgs({ launchAgent: 'claude' })).toEqual([])
    expect(trustLaunchArgs({ launchAgent: 'codex' })).toEqual([])
  })
})
