import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  lookupGitHubWorkItemDetailsForSource,
  lookupGitHubWorkItemForSource,
  lookupGitHubWorkItemByOwnerRepoForSource
} from './github-work-item-source-lookup'
import type { TaskSourceContext } from '../../../shared/task-source-context'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

beforeEach(() => {
  vi.mocked(callRuntimeRpc).mockReset()
  vi.stubGlobal('window', {
    api: {
      gh: {
        workItem: vi.fn().mockResolvedValue(null),
        workItemDetails: vi.fn(),
        workItemByOwnerRepo: vi.fn().mockResolvedValue(null)
      }
    }
  })
})

describe('GitHub source lookup routing', () => {
  it.each(['local', 'ssh:build-box'] as const)(
    'forwards %s source identity to exact repository IPC',
    async (hostId) => {
      const sourceContext: TaskSourceContext = { ...runtimeSourceContext, hostId, repoId: 'repo' }
      await lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(window.api.gh.workItemByOwnerRepo).toHaveBeenCalledWith({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('routes exact repository lookup to its source runtime instead of local IPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)
    await lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: '/repo',
      repoId: 'renderer-repo',
      sourceContext: runtimeSourceContext,
      owner: 'acme',
      repo: 'orca',
      host: 'github.com',
      number: 42,
      type: 'pr'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemByOwnerRepo',
      {
        repo: 'runtime-repo',
        owner: 'acme',
        ownerRepo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemByOwnerRepo).not.toHaveBeenCalled()
  })

  it('routes runtime-owned GitHub details through runtime RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'renderer-repo',
        target: { kind: 'environment', environmentId: 'env-1' },
        sourceContext: runtimeSourceContext,
        number: 42,
        type: 'issue',
        ownerRepo: { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'runtime-repo', number: 42, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('uses the renderer repo id for runtime details when the source has no repo id', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'renderer-repo',
      target: { kind: 'environment', environmentId: 'env-1' },
      sourceContext: { ...runtimeSourceContext, repoId: null },
      number: 42,
      type: 'pr'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'renderer-repo', number: 42, type: 'pr' },
      { timeoutMs: 30_000 }
    )
  })

  it('keeps local GitHub details on Electron IPC with source context', async () => {
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      hostId: 'local',
      repoId: 'local-repo'
    }

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: 'C:\\workspace\\app',
        repoId: 'local-repo',
        target: { kind: 'local' },
        sourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith({
      repoPath: 'C:\\workspace\\app',
      repoId: 'local-repo',
      sourceContext,
      number: 42,
      type: 'issue'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a local issue row repository to the repo-scoped details route', async () => {
    const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/fixture/widgets',
      repoId: 'local-repo',
      target: { kind: 'local' },
      number: 12,
      type: 'issue',
      ownerRepo
    })

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/fixture/widgets', ownerRepo })
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})

// Why: a workspace link can be a bare numeric slot carrying no task-source context, so a
// caller that knows the repo row must hand the read that row's owner host; the source-context
// fallback alone sends a runtime-owned repo's read to this app's IPC, which refuses it.
describe('GitHub work-item reads honour an explicit owner target', () => {
  const ownerTarget = { kind: 'environment', environmentId: 'env-1' } as const

  it('reads the work item on the given server, not on this app', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemForSource({
        repoPath: '/Users/mini/Code/orca/automations-project-scope',
        repoId: 'remote-repo',
        target: ownerTarget,
        number: 106,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItem',
      { repo: 'remote-repo', number: 106, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItem).not.toHaveBeenCalled()
  })

  it('reads issue details on the given server, not on this app', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/Users/mini/Code/orca/automations-project-scope',
        repoId: 'remote-repo',
        target: ownerTarget,
        number: 106,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'remote-repo', number: 106, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('falls back to this app when no target is given', async () => {
    vi.mocked(window.api.gh.workItem).mockResolvedValue(null)

    await lookupGitHubWorkItemForSource({
      repoPath: '/repo',
      repoId: 'local-repo',
      number: 12,
      type: 'pr'
    })

    expect(window.api.gh.workItem).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'local-repo',
      number: 12,
      type: 'pr'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
