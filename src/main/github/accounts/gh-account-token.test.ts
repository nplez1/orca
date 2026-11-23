import { describe, expect, it, vi } from 'vitest'
import type * as ghCapabilityState from './gh-capability-state'

const getGhMultiAccountCapability = vi.fn(async () => 'unsupported' as const)

vi.mock('./gh-capability-state', async (importOriginal) => ({
  ...(await importOriginal<typeof ghCapabilityState>()),
  getGhMultiAccountCapability
}))

vi.mock('../app/github-app-credentials', () => ({
  readGithubAppCredentials: async () => null
}))

const { resolveGhAccountToken } = await import('./gh-account-token')

describe('resolveGhAccountToken, for a GitHub App binding', () => {
  it('never probes gh’s multi-account capability, which only `gh auth token --user` needs', async () => {
    const error = await resolveGhAccountToken({
      host: 'github.com',
      user: 'lab-agent-np[bot]',
      kind: 'app'
    }).catch((caught: unknown) => caught)

    expect(getGhMultiAccountCapability).not.toHaveBeenCalled()
    expect(error).toMatchObject({
      code: 'gh_bound_account_unavailable',
      message: expect.stringContaining('No GitHub App is connected')
    })
  })
})
