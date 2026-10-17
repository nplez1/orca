import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'owning-host' })
}))
const { createWebAiVaultApi } = await import('./web-ai-vault-api')

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-08-02T00:00:00.000Z'
}

beforeEach(() => {
  callRuntimeResult.mockReset()
  callRuntimeResult.mockResolvedValue(EMPTY_RESULT)
})

describe('web session list arguments', () => {
  // Why: the depth is the host's decision, so a browser that drops it here takes
  // the host's default cap however the panel's History depth is set.
  it("forwards the panel's unlimited depth and drops the scope it cannot narrow", async () => {
    await createWebAiVaultApi().listSessions({ unlimited: true, scopePaths: ['/repo/app'] })

    expect(callRuntimeResult).toHaveBeenCalledExactlyOnceWith('aiVault.listSessions', {
      includeAntigravityIdeSessions: undefined,
      limit: undefined,
      unlimited: true,
      force: undefined,
      scopePaths: undefined,
      // The listing is read page by page, so even the first request asks for a page.
      paged: true,
      offset: 0,
      executionHostId: 'runtime:owning-host'
    })
  })

  it('keeps a bounded request’s cap and scope', async () => {
    await createWebAiVaultApi().listSessions({ limit: 250, scopePaths: ['/repo/app'] })

    expect(callRuntimeResult).toHaveBeenCalledExactlyOnceWith('aiVault.listSessions', {
      includeAntigravityIdeSessions: undefined,
      limit: 250,
      unlimited: undefined,
      force: undefined,
      scopePaths: ['/repo/app'],
      paged: true,
      offset: 0,
      executionHostId: 'runtime:owning-host'
    })
  })
})
