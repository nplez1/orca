import { describe, expect, it } from 'vitest'
import {
  clearHostSettingOverrideForIds,
  getEffectiveHostSetting,
  getHostSettingOverrideForIds,
  setHostSettingOverrideForIds
} from './host-setting-overrides'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from './execution-host'

const LOCAL = LOCAL_EXECUTION_HOST_ID
const SERVER = toRuntimeExecutionHostId('server-a')

describe('host setting overrides', () => {
  it('returns the client default when nothing is stored', () => {
    expect(
      getEffectiveHostSetting({ hostSettingOverrides: {} }, LOCAL, 'defaultRepoRoot', '/x')
    ).toBe('/x')
  })

  it('reads the first id that holds a value, so a merged machine resolves either way', () => {
    const settings = { hostSettingOverrides: { [SERVER]: { defaultWorktreeLocation: '/srv' } } }
    expect(getHostSettingOverrideForIds(settings, [LOCAL, SERVER], 'defaultWorktreeLocation')).toBe(
      '/srv'
    )
    expect(getHostSettingOverrideForIds(settings, [SERVER, LOCAL], 'defaultWorktreeLocation')).toBe(
      '/srv'
    )
  })

  it('writes the visible id and clears the alias so the old value cannot shadow it', () => {
    const settings = {
      hostSettingOverrides: {
        [LOCAL]: { defaultWorktreeLocation: '/old' },
        [SERVER]: { displayLabel: 'Boston' }
      }
    }
    expect(
      setHostSettingOverrideForIds(settings, [SERVER, LOCAL], 'defaultWorktreeLocation', '/new')
    ).toEqual({
      [SERVER]: { displayLabel: 'Boston', defaultWorktreeLocation: '/new' }
    })
  })

  it('clears every id a merged machine answers to', () => {
    const settings = {
      hostSettingOverrides: {
        [LOCAL]: { defaultWorktreeLocation: '/a', defaultRepoRoot: '/b' },
        [SERVER]: { defaultWorktreeLocation: '/c' }
      }
    }
    expect(
      clearHostSettingOverrideForIds(settings, [SERVER, LOCAL], 'defaultWorktreeLocation')
    ).toEqual({
      [LOCAL]: { defaultRepoRoot: '/b' }
    })
  })
})
