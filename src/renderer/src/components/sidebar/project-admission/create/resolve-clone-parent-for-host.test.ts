import { describe, expect, it, vi } from 'vitest'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../../../shared/execution-host/execution-host-registry'
import { buildProjectHostSetupOptions } from '@/lib/project-host-setup-options'
import {
  resolveCloneParentForHost,
  resolveRunTargetCloneParent
} from './resolve-clone-parent-for-host'

const runtimeHostId = 'runtime:env-b' as const
const SSH_BOX = toSshExecutionHostId('box')
const SERVER = toRuntimeExecutionHostId('env-box')

/** A merged pair as the picker builds it: main reports the server as this machine's row. */
function mergedBoxHosts(): ReturnType<typeof buildExecutionHostRegistry> {
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: new Map([['box', 'Box']]),
    sshConnectionStates: new Map([
      [
        'box',
        {
          targetId: 'box',
          status: 'connected' as const,
          error: null,
          reconnectAttempt: 0,
          managedServer: { kind: 'managed' as const, environmentId: 'env-box' }
        }
      ]
    ]),
    runtimeEnvironments: [{ id: 'env-box', orcadDeployment: { sshTargetId: 'box' } }]
  })
}

describe('resolveCloneParentForHost', () => {
  it('reads a runtime host home when nothing is stored and derives the layout convention', async () => {
    const probe = vi.fn(async () => '/home/alice')
    const parent = await resolveCloneParentForHost({
      settings: { workspaceDir: '/Users/me/orca' },
      hostIds: [runtimeHostId],
      layoutMode: 'flat',
      probeHostHome: probe
    })

    expect(probe).toHaveBeenCalledWith('env-b')
    expect(parent).toBe('/home/alice/orca/projects')
  })

  it('returns no destination when the home probe fails, never this computer’s workspaceDir', async () => {
    const parent = await resolveCloneParentForHost({
      settings: { workspaceDir: '/Users/me/orca' },
      hostIds: [runtimeHostId],
      probeHostHome: async () => null
    })

    expect(parent).toBe('')
  })

  it('uses a stored repo root without probing the host', async () => {
    const probe = vi.fn(async () => '/home/alice')
    const parent = await resolveCloneParentForHost({
      settings: {
        workspaceDir: '/Users/me/orca',
        hostSettingOverrides: { 'runtime:env-b': { defaultRepoRoot: '/srv/checkouts' } }
      },
      hostIds: [runtimeHostId],
      probeHostHome: probe
    })

    expect(probe).not.toHaveBeenCalled()
    expect(parent).toBe('/srv/checkouts')
  })

  it('gives an SSH host no destination, since cloning there is refused', async () => {
    const parent = await resolveCloneParentForHost({
      settings: { workspaceDir: '/Users/me/orca' },
      hostIds: ['ssh:devbox'],
      probeHostHome: async () => '/home/alice'
    })

    expect(parent).toBe('')
  })

  it('uses this computer’s own workspace folder for the local host', async () => {
    const parent = await resolveCloneParentForHost({
      settings: { workspaceDir: '/Users/me/orca' },
      hostIds: ['local'],
      layoutMode: 'flat',
      probeHostHome: async () => null
    })

    expect(parent).toBe('/Users/me/orca')
  })
})

describe('resolveRunTargetCloneParent', () => {
  it('clones into the folder the ssh id of a merged machine holds', async () => {
    const option = buildProjectHostSetupOptions({
      projectId: 'github:acme/app',
      projectHostSetups: [],
      eligibleRepos: [],
      hosts: mergedBoxHosts()
    }).find((candidate) => candidate.kind === 'needs-setup' && candidate.hostId === SERVER)
    if (option?.kind !== 'needs-setup') {
      throw new Error('expected the merged server to be a run-target row')
    }

    const parent = await resolveRunTargetCloneParent({
      settings: { hostSettingOverrides: { [SSH_BOX]: { defaultRepoRoot: '/srv/repos' } } },
      option,
      layoutMode: 'repo-nested'
    })

    expect(option.equivalentHostIds).toEqual([SERVER, SSH_BOX])
    expect(parent).toBe('/srv/repos')
  })
})
