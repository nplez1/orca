import { describe, expect, it } from 'vitest'
import { isLockedSourceHostTarget } from './locked-target-host'

describe('locked workspace copy target', () => {
  it('matches the host the workspace already lives on', () => {
    expect(
      isLockedSourceHostTarget({
        sourceHostId: 'ssh:build-box',
        selectedTargetHostIds: ['ssh:build-box']
      })
    ).toBe(true)
    expect(
      isLockedSourceHostTarget({ sourceHostId: 'ssh:build-box', selectedTargetHostIds: ['local'] })
    ).toBe(false)
  })

  it('treats a paired runtime owner as the same machine', () => {
    expect(
      isLockedSourceHostTarget({
        sourceHostId: 'ssh:nested',
        sourceRuntimeOwnerEnvironmentId: 'env-b',
        selectedTargetHostIds: ['runtime:env-b']
      })
    ).toBe(true)
  })

  it('checks every id that names the chosen target', () => {
    expect(
      isLockedSourceHostTarget({
        sourceHostId: 'local',
        selectedTargetHostIds: ['runtime:env-b', 'local']
      })
    ).toBe(true)
  })

  it('never locks a target when the source host is unknown or nothing is selected', () => {
    expect(isLockedSourceHostTarget({ selectedTargetHostIds: ['local'] })).toBe(false)
    expect(
      isLockedSourceHostTarget({ sourceHostId: 'local', selectedTargetHostIds: [null, undefined] })
    ).toBe(false)
  })
})
