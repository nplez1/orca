import { describe, expect, it } from 'vitest'
import { AiVaultListSessionsParams } from './ai-vault-params'

// The list request gained an optional `query` while desktop parents, the web
// client and mobile ship on their own cadence: an old client sends no query at
// all, and a newer one may send a refinement the host cannot express. Neither may
// turn a listing into a rejection — see docs/reference/remote-wire-compatibility.md.
describe('AiVaultListSessionsParams cross-version skew', () => {
  it('accepts an old client request that carries no query at all', () => {
    const parsed = AiVaultListSessionsParams.parse({ limit: 50, scopePaths: ['/repo'] })

    expect(parsed.limit).toBe(50)
    expect(parsed.scopePaths).toEqual(['/repo'])
    expect(parsed).not.toHaveProperty('query')
  })

  it('keeps an ordinary query as the host filter', () => {
    expect(AiVaultListSessionsParams.parse({ query: '  needle  ' }).query).toBe('needle')
    expect(AiVaultListSessionsParams.parse({ query: '' }).query).toBe('')
  })

  it.each(['repo:orca', 'path:/repo/subdir', 'a'.repeat(9000)])(
    'reduces a query the host cannot express to no host filter: %s',
    (query) => {
      // Empty means "the client filters this itself" rather than a rejection.
      expect(AiVaultListSessionsParams.parse({ query }).query).toBe('')
    }
  )

  it('ignores unknown future params instead of rejecting the request', () => {
    const parsed = AiVaultListSessionsParams.parse({ query: 'needle', generation: 7 })

    expect(parsed.query).toBe('needle')
    expect(parsed).not.toHaveProperty('generation')
  })
})
