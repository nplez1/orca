import { describe, expect, it, vi } from 'vitest'
import { SshFilesystemProvider } from './ssh-filesystem-provider'
import type {
  WorkspacePathSearchRequest,
  WorkspacePathSearchResponse
} from '../../shared/workspace-path-search-contract'
import {
  RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
  WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY
} from '../../shared/workspace-path-search-capability'

function request(includeDotfiles = true): WorkspacePathSearchRequest {
  return {
    identity: {
      query: 'src app',
      consumer: { consumerId: 'consumer-1', sequence: 1 },
      owner: {
        executionHost: { provider: 'ssh', incarnationId: 'connection-1' },
        authorizedCanonicalRoot: '/repo'
      },
      generationId: null,
      mode: 'name-filter',
      scope: {
        pathSet: 'included',
        includeDotfiles,
        includeIgnoredFiles: false,
        excludePathSegments: []
      },
      pageBudget: { maxPaths: 32, maxSerializedBytes: 500_000 }
    },
    correlationId: 'correlation-1'
  }
}

function response(requestValue = request()): WorkspacePathSearchResponse {
  const identity = requestValue.identity
  return {
    requestIdentity: identity,
    generationId: 'relay-live-1',
    scopeFingerprint: JSON.stringify(identity.scope),
    scopeRuleVersion: 'live-path-search-v1',
    rows: [{ relativePath: 'src/app.ts' }],
    rowClassificationFlags: [0],
    retainedCount: 1,
    state: {
      coverage: 'complete',
      freshness: 'no-known-gap',
      countProvenance: 'exact-snapshot',
      searchComplete: true
    },
    count: { value: 1, provenance: 'exact-snapshot' }
  }
}

describe('SSH workspace name-filter provider', () => {
  it('uses the negotiated structured relay method and forwards cancellation', async () => {
    const controller = new AbortController()
    const mux = {
      request: vi.fn(async (method: string, _params?: unknown, _options?: unknown) =>
        method === 'fs.getCapabilities'
          ? {
              [WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY]:
                RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR
            }
          : response()
      ),
      onNotification: () => () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The multiplexer double implements request and notification registration used by this provider path.
    const provider = new SshFilesystemProvider('connection-1', mux as never)

    await expect(
      provider.searchWorkspacePathNameFilter('/repo', request(), { signal: controller.signal })
    ).resolves.toMatchObject({
      count: { value: 1, provenance: 'exact-snapshot' },
      rows: [{ relativePath: 'src/app.ts' }]
    })
    expect(mux.request.mock.calls.map(([method]) => method)).toEqual([
      'fs.getCapabilities',
      'fs.searchPaths'
    ])
    expect(mux.request.mock.calls[1]?.[2]).toMatchObject({ signal: controller.signal })
    provider.dispose()
  })

  it('allows the default dotfile-visible scope when a relay cannot hide dotfiles', async () => {
    const requestValue = request()
    const mux = {
      request: vi.fn(async (method: string) =>
        method === 'fs.getCapabilities'
          ? {
              [WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY]: {
                ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
                supportsDotfileVisibility: false
              }
            }
          : response(requestValue)
      ),
      onNotification: () => () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The multiplexer double implements request and notification registration used by this provider path.
    const provider = new SshFilesystemProvider('connection-1', mux as never)

    await expect(
      provider.searchWorkspacePathNameFilter('/repo', requestValue)
    ).resolves.toMatchObject({
      requestIdentity: { scope: { includeDotfiles: true } },
      count: { value: 1, provenance: 'exact-snapshot' }
    })
    expect(mux.request.mock.calls.map(([method]) => method)).toEqual([
      'fs.getCapabilities',
      'fs.searchPaths'
    ])
    provider.dispose()
  })

  it('does not call the structured method when a relay cannot hide requested dotfiles', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({
        [WORKSPACE_PATH_SEARCH_CAPABILITY_DOCUMENT_KEY]: {
          ...RELAY_WORKSPACE_PATH_SEARCH_CAPABILITY_DESCRIPTOR,
          supportsDotfileVisibility: false
        }
      }),
      onNotification: () => () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The multiplexer double implements request and notification registration used by this provider path.
    const provider = new SshFilesystemProvider('connection-1', mux as never)

    await expect(
      provider.searchWorkspacePathNameFilter('/repo', request(false))
    ).resolves.toBeNull()
    expect(mux.request.mock.calls.map(([method]) => method)).toEqual(['fs.getCapabilities'])
    provider.dispose()
  })

  it('does not call the structured method on a legacy relay', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({ quickOpenSearchVersion: 1 }),
      onNotification: () => () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The multiplexer double implements request and notification registration used by this provider path.
    const provider = new SshFilesystemProvider('connection-legacy', mux as never)

    await expect(provider.searchWorkspacePathNameFilter('/repo', request())).resolves.toBeNull()
    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(mux.request).toHaveBeenCalledWith('fs.getCapabilities', undefined, {
      timeoutMs: 5_000
    })
    provider.dispose()
  })
})
