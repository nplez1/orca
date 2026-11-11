import { describe, expect, it, vi } from 'vitest'
import { resolveCloneParentForHost } from './resolve-clone-parent-for-host'

const runtimeHostId = 'runtime:env-b' as const

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
