import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER,
  credentialHolders,
  forgetCredentialHoldings,
  forgetHostHoldings,
  recordCredentialHoldings,
  revokeReplicatedCredential
} from './host-settings-replication-ledger'

const DEEPSEEK = 'api-key:deepseek'
const JIRA = 'jira:site-1'

describe('the credential-holding ledger', () => {
  it('records which hosts received which credential, idempotently', () => {
    const once = recordCredentialHoldings(EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER, {
      credentialIds: [DEEPSEEK, JIRA],
      hostId: 'host-1'
    })
    const twice = recordCredentialHoldings(once, {
      credentialIds: [DEEPSEEK],
      hostId: 'host-1'
    })

    expect(credentialHolders(twice, DEEPSEEK)).toEqual(['host-1'])
    expect(credentialHolders(twice, JIRA)).toEqual(['host-1'])
  })

  it('answers which hosts hold a credential across several hosts', () => {
    let ledger = recordCredentialHoldings(EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER, {
      credentialIds: [DEEPSEEK],
      hostId: 'host-2'
    })
    ledger = recordCredentialHoldings(ledger, { credentialIds: [DEEPSEEK], hostId: 'host-1' })

    expect(credentialHolders(ledger, DEEPSEEK)).toEqual(['host-1', 'host-2'])
  })

  it('keeps the hosts a revocation could not reach', () => {
    const ledger = recordCredentialHoldings(EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER, {
      credentialIds: [DEEPSEEK],
      hostId: 'host-1'
    })

    const afterPartial = forgetCredentialHoldings(ledger, DEEPSEEK, [])

    expect(credentialHolders(afterPartial, DEEPSEEK)).toEqual(['host-1'])
  })

  it('drops a host entirely on unpair, without touching another credential', () => {
    let ledger = recordCredentialHoldings(EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER, {
      credentialIds: [DEEPSEEK, JIRA],
      hostId: 'host-1'
    })
    ledger = recordCredentialHoldings(ledger, { credentialIds: [DEEPSEEK], hostId: 'host-2' })

    const afterUnpair = forgetHostHoldings(ledger, 'host-1')

    expect(credentialHolders(afterUnpair, JIRA)).toEqual([])
    expect(credentialHolders(afterUnpair, DEEPSEEK)).toEqual(['host-2'])
  })
})

describe('revoking a replicated credential', () => {
  const ledgerWithTwoHosts = recordCredentialHoldings(EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER, {
    credentialIds: [DEEPSEEK],
    hostId: 'host-1'
  })
  const bothHosts = recordCredentialHoldings(ledgerWithTwoHosts, {
    credentialIds: [DEEPSEEK],
    hostId: 'host-2'
  })

  it('reports revoked only after the host store stops answering with the credential', async () => {
    const revoke = vi.fn(async () => {})
    const holds = vi.fn(async () => false)

    const { results, ledger } = await revokeReplicatedCredential({
      credentialId: DEEPSEEK,
      ledger: bothHosts,
      transport: { revoke, holds }
    })

    expect(results).toEqual([
      { credentialId: DEEPSEEK, hostId: 'host-1', outcome: 'revoked' },
      { credentialId: DEEPSEEK, hostId: 'host-2', outcome: 'revoked' }
    ])
    expect(credentialHolders(ledger, DEEPSEEK)).toEqual([])
  })

  it('does not claim a deletion the host still answers with', async () => {
    const { results, ledger } = await revokeReplicatedCredential({
      credentialId: DEEPSEEK,
      ledger: bothHosts,
      transport: { revoke: async () => {}, holds: async () => true }
    })

    expect(results.every((result) => result.outcome === 'stillHeld')).toBe(true)
    // Why kept: a host that still holds the token is exactly the one a retry must reach.
    expect(credentialHolders(ledger, DEEPSEEK)).toEqual(['host-1', 'host-2'])
  })

  it('treats an unreachable host as unproven, not as deleted', async () => {
    const { results, ledger } = await revokeReplicatedCredential({
      credentialId: DEEPSEEK,
      ledger: bothHosts,
      transport: {
        revoke: async (hostId) => {
          if (hostId === 'host-1') {
            throw new Error('no route to host')
          }
        },
        holds: async () => false
      }
    })

    expect(results).toEqual([
      { credentialId: DEEPSEEK, hostId: 'host-1', outcome: 'unreachable' },
      { credentialId: DEEPSEEK, hostId: 'host-2', outcome: 'revoked' }
    ])
    expect(credentialHolders(ledger, DEEPSEEK)).toEqual(['host-1'])
  })

  it('treats an unverifiable deletion as unproven', async () => {
    const { results, ledger } = await revokeReplicatedCredential({
      credentialId: DEEPSEEK,
      ledger: bothHosts,
      transport: {
        revoke: async () => {},
        holds: async () => {
          throw new Error('host went away mid-verification')
        }
      }
    })

    expect(results.every((result) => result.outcome === 'unreachable')).toBe(true)
    expect(credentialHolders(ledger, DEEPSEEK)).toEqual(['host-1', 'host-2'])
  })

  it('does nothing when no host holds the credential', async () => {
    const revoke = vi.fn(async () => {})

    const { results } = await revokeReplicatedCredential({
      credentialId: DEEPSEEK,
      ledger: EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER,
      transport: { revoke, holds: async () => false }
    })

    expect(results).toEqual([])
    expect(revoke).not.toHaveBeenCalled()
  })
})
