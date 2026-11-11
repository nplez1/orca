import { describe, expect, it } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../shared/execution-host'
import { resolveSettingsHostScope, type SettingsHostScopeHost } from './settings-host-scope'

const LOCAL_HOST: SettingsHostScopeHost = { id: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac' }
const SERVER_HOST: SettingsHostScopeHost = {
  id: toRuntimeExecutionHostId('server-a'),
  label: 'Boston'
}
/** A merged pair: the SSH row stands for the server it deploys. */
const MERGED_SSH_HOST: SettingsHostScopeHost = {
  id: toSshExecutionHostId('builder'),
  label: 'builder.example.com',
  aliasHostIds: [toRuntimeExecutionHostId('server-b')]
}
const MERGED_AWAY_HOST: SettingsHostScopeHost = {
  id: toRuntimeExecutionHostId('server-b'),
  label: 'builder.example.com',
  mergedIntoHostId: toSshExecutionHostId('builder')
}
const MACHINE_ONLY_HOST: SettingsHostScopeHost = {
  id: toSshExecutionHostId('bare'),
  label: 'bare.example.com'
}

const HOSTS = [LOCAL_HOST, SERVER_HOST, MERGED_SSH_HOST, MERGED_AWAY_HOST, MACHINE_ONLY_HOST]

function resolve(choice: Parameters<typeof resolveSettingsHostScope>[0]['choice']) {
  return resolveSettingsHostScope({
    choice,
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    hosts: HOSTS,
    savedEnvironmentIds: ['server-a', 'server-b'],
    catalogHydrated: true
  })
}

describe('resolveSettingsHostScope', () => {
  it('resolves this computer to the local target', () => {
    expect(resolve(LOCAL_EXECUTION_HOST_ID)).toMatchObject({
      hostId: LOCAL_EXECUTION_HOST_ID,
      target: { kind: 'local' },
      available: true
    })
  })

  it('resolves a server row to its environment', () => {
    expect(resolve(SERVER_HOST.id)).toMatchObject({
      hostId: SERVER_HOST.id,
      label: 'Boston',
      target: { kind: 'environment', environmentId: 'server-a' },
      available: true
    })
  })

  it('resolves a merged SSH row to the server it deploys', () => {
    expect(resolve(MERGED_SSH_HOST.id)).toMatchObject({
      target: { kind: 'environment', environmentId: 'server-b' },
      equivalentHostIds: [MERGED_SSH_HOST.id, toRuntimeExecutionHostId('server-b')]
    })
  })

  it('shows a merged-away id as the row that stands for it', () => {
    expect(resolve(MERGED_AWAY_HOST.id).hostId).toBe(MERGED_SSH_HOST.id)
  })

  it('never falls back to local for an SSH host without a server', () => {
    const scope = resolve(MACHINE_ONLY_HOST.id)
    expect(scope.target).toBeNull()
    expect(scope.available).toBe(true)
    expect(scope.label).toBe('bare.example.com')
  })

  it('keeps a removed server available while the catalog is unhydrated', () => {
    const scope = resolveSettingsHostScope({
      choice: toRuntimeExecutionHostId('gone'),
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      hosts: [LOCAL_HOST],
      savedEnvironmentIds: [],
      catalogHydrated: false
    })
    expect(scope.available).toBe(true)
    expect(scope.target).toEqual({ kind: 'environment', environmentId: 'gone' })
  })

  it('marks a removed server unavailable once the catalog is hydrated', () => {
    const scope = resolveSettingsHostScope({
      choice: toRuntimeExecutionHostId('gone'),
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      hosts: [LOCAL_HOST],
      savedEnvironmentIds: ['server-a'],
      catalogHydrated: true
    })
    expect(scope.available).toBe(false)
    // A stale id must not be shown as this computer either.
    expect(scope.target).toEqual({ kind: 'environment', environmentId: 'gone' })
  })

  it('seeds the default host when nothing is chosen', () => {
    const scope = resolveSettingsHostScope({
      choice: null,
      defaultHostId: SERVER_HOST.id,
      hosts: HOSTS,
      savedEnvironmentIds: ['server-a'],
      catalogHydrated: true
    })
    expect(scope.hostId).toBe(SERVER_HOST.id)
  })
})
