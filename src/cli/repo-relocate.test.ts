import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('./runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'

async function run(args: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  await main(args, '/tmp/not-an-orca-worktree')
  return logSpy.mock.calls.flat().join('\n')
}

describe('orca cli repo relocate', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes --dry-run through and reports the move it would make', async () => {
    queueFixtures(
      callMock,
      okFixture('req_relocate_dry', {
        repoId: 'r1',
        decision: 'ready',
        plan: {
          containerPath: '/ws/homelab',
          targetPath: '/ws/homelab/main',
          defaultBranchName: 'main'
        }
      })
    )

    const printed = await run(['repo', 'relocate', '--repo', 'name:homelab', '--dry-run'])

    expect(callMock).toHaveBeenCalledWith('repo.relocate', {
      repo: 'name:homelab',
      dryRun: true
    })
    expect(printed).toContain('Would move r1 to /ws/homelab/main')
  })

  it('omits dryRun on a real run and reports what moved', async () => {
    queueFixtures(
      callMock,
      okFixture('req_relocate', {
        repoId: 'r1',
        decision: 'ready',
        plan: {
          containerPath: '/ws/homelab',
          targetPath: '/ws/homelab/main',
          defaultBranchName: 'main'
        },
        outcome: { kind: 'relocated', from: '/Code/homelab', to: '/ws/homelab/main' }
      })
    )

    const printed = await run(['repo', 'relocate', '--repo', 'name:homelab'])

    expect(callMock).toHaveBeenCalledWith('repo.relocate', {
      repo: 'name:homelab',
      dryRun: undefined
    })
    expect(printed).toContain('Moved /Code/homelab to /ws/homelab/main')
  })

  it('explains a repo that needs no move instead of failing', async () => {
    queueFixtures(
      callMock,
      okFixture('req_relocate_noop', { repoId: 'r1', decision: 'already-in-container' })
    )

    const printed = await run(['repo', 'relocate', '--repo', 'name:orca'])

    expect(printed).toContain('Not applicable: its checkout is already inside its project folder')
    expect(process.exitCode).toBeUndefined()
  })

  it('points at the command when a listed repo is outside its project folder', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_list', {
        repos: [{ id: 'r1', displayName: 'homelab', path: '/Code/homelab' }],
        relocationRequiredRepoIds: ['r1']
      })
    )

    const printed = await run(['repo', 'list'])

    expect(printed).toContain('orca repo relocate --repo r1')
  })

  it('says nothing about relocation when every repo is where it belongs', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_list_clean', {
        repos: [{ id: 'r1', displayName: 'orca', path: '/ws/orca/main' }],
        relocationRequiredRepoIds: []
      })
    )

    const printed = await run(['repo', 'list'])

    expect(printed).not.toContain('repo relocate')
  })

  it('explains a refusal that happened after the plan was ready', async () => {
    queueFixtures(
      callMock,
      okFixture('req_relocate_busy', {
        repoId: 'r1',
        decision: 'ready',
        plan: {
          containerPath: '/ws/homelab',
          targetPath: '/ws/homelab/main',
          defaultBranchName: 'main'
        },
        outcome: { kind: 'live-sessions' }
      })
    )

    const printed = await run(['repo', 'relocate', '--repo', 'name:homelab'])

    expect(printed).toContain('Refused: a terminal is still attached to one of its workspaces')
  })
})
