import { describe, expect, it } from 'vitest'
import { getDefaultRepoRootConvention, getEffectiveHostRepoRoot } from './host-repo-root'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from './execution-host'

const LOCAL = LOCAL_EXECUTION_HOST_ID
const SERVER = toRuntimeExecutionHostId('server-a')

describe('getDefaultRepoRootConvention', () => {
  it('is <home>/orca/projects', () => {
    expect(getDefaultRepoRootConvention('/Users/me')).toBe('/Users/me/orca/projects')
  })

  it('keeps a Windows separator', () => {
    expect(getDefaultRepoRootConvention('C:\\Users\\me')).toBe('C:\\Users\\me\\orca\\projects')
  })

  it('is empty without a home', () => {
    expect(getDefaultRepoRootConvention('  ')).toBe('')
  })
})

describe('getEffectiveHostRepoRoot', () => {
  it('prefers a stored root', () => {
    expect(
      getEffectiveHostRepoRoot({
        settings: { hostSettingOverrides: { [SERVER]: { defaultRepoRoot: '/srv/src' } } },
        hostIds: [SERVER],
        hostHome: '/home/me'
      })
    ).toBe('/srv/src')
  })

  it('falls back to the convention for that host', () => {
    expect(
      getEffectiveHostRepoRoot({
        settings: { hostSettingOverrides: {} },
        hostIds: [LOCAL],
        hostHome: '/home/me'
      })
    ).toBe('/home/me/orca/projects')
  })

  it('reverts to the convention when the stored root is cleared', () => {
    expect(
      getEffectiveHostRepoRoot({
        settings: { hostSettingOverrides: { [SERVER]: { defaultRepoRoot: '  ' } } },
        hostIds: [SERVER],
        hostHome: '/home/me'
      })
    ).toBe('/home/me/orca/projects')
  })
})
