import { describe, expect, it } from 'vitest'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import type { AiVaultSearchStatus } from '../../shared/ai-vault-search-types'
import type { SessionSearchClient } from './ai-vault-search-host-fanout'
import { searchAllExecutionHostsStatus } from './ai-vault-search-status-aggregation'

// `contentEnabled` is additive: a host older than the metadata/content split does
// not report it. The merge must say "not reported" rather than invent false, and a
// host that never answered must not be read as having reported — see
// docs/reference/remote-wire-compatibility.md.

function statusWith(args: { enabled?: boolean; contentEnabled?: boolean }): AiVaultSearchStatus {
  const base: AiVaultSearchStatus = {
    ...unavailableSessionSearchStatus(),
    enabled: args.enabled ?? true
  }
  return args.contentEnabled === undefined ? base : { ...base, contentEnabled: args.contentEnabled }
}

function statusClient(status: AiVaultSearchStatus | null): SessionSearchClient {
  return {
    searchSessions: async () => ({ kind: 'unavailable', reason: 'no-service' }),
    searchStatus: async () => {
      if (status) {
        return status
      }
      throw new Error('no service')
    }
  }
}

function deps(local: SessionSearchClient, ssh: SessionSearchClient | null = null) {
  return {
    localClient: local,
    discoverSshHosts: () => (ssh ? [{ targetId: 'box' }] : []),
    sshClient: () => ssh ?? statusClient(null),
    discoverRuntimeHosts: () => [],
    runtimeClient: () => null
  }
}

describe('searchAllExecutionHostsStatus cross-version skew', () => {
  it('reports content consent only when every answering host reports it', async () => {
    const granted = await searchAllExecutionHostsStatus(
      deps(
        statusClient(statusWith({ contentEnabled: true })),
        statusClient(statusWith({ contentEnabled: true }))
      )
    )
    expect(granted.contentEnabled).toBe(true)

    const denied = await searchAllExecutionHostsStatus(
      deps(
        statusClient(statusWith({ contentEnabled: false })),
        statusClient(statusWith({ contentEnabled: false }))
      )
    )
    expect(denied.contentEnabled).toBe(false)
  })

  it('omits content consent when any answering host does not report it', async () => {
    const aggregate = await searchAllExecutionHostsStatus(
      deps(
        statusClient(statusWith({ contentEnabled: true })),
        statusClient(statusWith({ enabled: true }))
      )
    )

    expect(aggregate).not.toHaveProperty('contentEnabled')
    expect(aggregate.enabled).toBe(true)
  })

  it('does not read a host that did not answer as having reported no consent', async () => {
    const aggregate = await searchAllExecutionHostsStatus(
      deps(statusClient(statusWith({ contentEnabled: true })), statusClient(null))
    )

    expect(aggregate.contentEnabled).toBe(true)
    expect(aggregate.enabled).toBe(true)
  })

  it('returns the absent-service sentinel when no host reports', async () => {
    const aggregate = await searchAllExecutionHostsStatus(deps(statusClient(null)))

    expect(aggregate).toEqual(unavailableSessionSearchStatus())
    expect(aggregate).not.toHaveProperty('contentEnabled')
  })
})
