import { describe, expect, it } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import { getRunTargetCloneAvailability } from './run-target-clone-availability'

const option: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: 'needs-setup:runtime:env-b',
  projectId: 'github:acme/app',
  hostId: 'runtime:env-b',
  label: 'Build box',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

const remote = 'git@github.com:acme/app.git'

describe('getRunTargetCloneAvailability', () => {
  it('clones onto a host that can take a project, for a git project with a remote', () => {
    expect(getRunTargetCloneAvailability(option, { projectKind: 'git', cloneUrl: remote })).toEqual(
      { kind: 'clone' }
    )
  })

  it('offers only an existing folder for a folder project', () => {
    const availability = getRunTargetCloneAvailability(option, {
      projectKind: 'folder',
      cloneUrl: remote
    })

    expect(availability.kind).toBe('existing-folder-only')
  })

  it('offers only an existing folder when the project has no remote to clone', () => {
    const availability = getRunTargetCloneAvailability(option, {
      projectKind: 'git',
      cloneUrl: '   '
    })

    expect(availability.kind).toBe('existing-folder-only')
  })

  it('refuses without a reason of its own, so the host keeps the one it already shows', () => {
    // Why: an unhealthy host, an SSH host and a host-local project all land here, and each already
    // explains itself in the row's detail; inventing a clone reason would overwrite that.
    expect(
      getRunTargetCloneAvailability(
        { ...option, canSetLocation: false },
        { projectKind: 'git', cloneUrl: remote }
      )
    ).toEqual({ kind: 'refused' })
  })
})
