import { describe, expect, it } from 'vitest'
import { defaultCreationHost, defaultScopeHost } from './default-creation-host'

describe('defaultCreationHost', () => {
  it('is this computer unless a server is chosen', () => {
    expect(defaultCreationHost(null)).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: null })).toEqual({ kind: 'local' })
    expect(defaultCreationHost({ activeRuntimeEnvironmentId: ' env-a ' })).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })
})

describe('defaultScopeHost', () => {
  it('is the scope host a row-less settings surface resolves to', () => {
    expect(defaultScopeHost(null)).toEqual({ kind: 'local' })
    expect(defaultScopeHost({ activeRuntimeEnvironmentId: 'env-a' })).toEqual({
      kind: 'environment',
      environmentId: 'env-a'
    })
  })
})
