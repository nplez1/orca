import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, sshSearch, sshHosts, runtimeSearch } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  sshSearch: vi.fn(),
  sshHosts: vi.fn(),
  runtimeSearch: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, handler)
  },
  ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) }
}))
vi.mock('./ssh', () => ({
  requestActiveSshSessionSearch: sshSearch,
  getActiveSshAiVaultHostInfos: sshHosts
}))

import { registerAiVaultSearchHandlers } from './ai-vault-search'
import { aiVaultApi } from '../../preload/api/ai-vault-bridge'
import { setSessionSearchService } from '../ai-vault-search/session-search-service-registry'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault-search-client'
import {
  aiVaultSearchHit,
  aiVaultSearchResults,
  fakeSearchService,
  searchResults
} from '../../shared/ai-vault-search-test-fixture'
import { resetMergedSearchOrdersForTests } from './ai-vault-search-all-hosts'
beforeEach(() => {
  handlers.clear()
  sshSearch.mockReset()
  sshHosts.mockReset().mockReturnValue([])
  runtimeSearch.mockReset()
  resetMergedSearchOrdersForTests()
  registerAiVaultSearchHandlers({
    callRuntimeSearch: runtimeSearch
  })
})
afterEach(() => setSessionSearchService(null))

describe('desktop IPC and preload search boundary', () => {
  it('round-trips local results and separate status through the actual preload', async () => {
    setSessionSearchService(fakeSearchService())
    expect(await aiVaultApi.searchSessions({ query: 'needle' })).toMatchObject({
      kind: 'results',
      hits: [
        {
          source: { presence: 'present', filePath: '/host/transcript.jsonl' },
          resumeCommand: 'host-resume-command'
        }
      ]
    })
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'local')).toMatchObject({
      hits: [{ source: { filePath: '/host/transcript.jsonl' } }]
    })
    expect(await aiVaultApi.searchStatus()).toMatchObject({ enabled: true, generation: 7 })
    expect(sshSearch).not.toHaveBeenCalled()
    expect(runtimeSearch).not.toHaveBeenCalled()
  })
  it('rejects malformed renderer input and uses typed unavailable', async () => {
    expect(await aiVaultApi.searchSessions({ query: 'needle' })).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    await expect(handlers.get('aiVault:searchSessions')!(null, { query: 1 })).rejects.toThrow()
    await expect(handlers.get('aiVault:searchStatus')!(null, 42)).rejects.toThrow()
  })
  it('routes one SSH target without touching the local index and redacts received paths', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    sshSearch.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'ssh:ssh-host')
    expect(sshSearch).toHaveBeenCalledWith('ssh-host', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20
    })
    expect(result).toMatchObject({
      hits: [{ executionHostId: 'ssh:ssh-host', source: { presence: 'present' } }]
    })
    expect(JSON.stringify(result)).not.toContain('resumeCommand')
    expect(local.search).not.toHaveBeenCalled()
    sshSearch.mockRejectedValue(new Error('SSH relay is not ready'))
    await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'ssh:ssh-host')).rejects.toThrow(
      'SSH relay is not ready'
    )
    expect(local.search).not.toHaveBeenCalled()
  })
  it('routes one runtime environment over its RPC and stamps the answering host', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    runtimeSearch.mockResolvedValue(searchResults())
    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')
    expect(runtimeSearch).toHaveBeenCalledWith('env-1', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 20
    })
    expect(result).toMatchObject({
      hits: [{ executionHostId: 'runtime:env-1', source: { presence: 'present' } }]
    })
    expect(JSON.stringify(result)).not.toContain('/host/transcript.jsonl')
    expect(local.search).not.toHaveBeenCalled()
    runtimeSearch.mockResolvedValue(unavailableSessionSearchStatus())
    expect(await aiVaultApi.searchStatus('runtime:env-1')).toEqual(unavailableSessionSearchStatus())
    expect(runtimeSearch).toHaveBeenLastCalledWith('env-1', 'aiVault.searchStatus', {})
  })
  it('maps a runtime unknown-method refusal to unavailable and keeps transport errors', async () => {
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('unknown method'), { code: 'method_not_found' })
    )
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    runtimeSearch.mockRejectedValue(
      Object.assign(new Error('runtime disconnected'), { code: 'connection_lost' })
    )
    await expect(aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).rejects.toThrow(
      'runtime disconnected'
    )
  })
  it('reports unavailable when no runtime transport is injected', async () => {
    handlers.clear()
    registerAiVaultSearchHandlers()
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'runtime:env-1')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(await aiVaultApi.searchStatus('runtime:env-1')).toMatchObject({
      enabled: false,
      phase: 'idle'
    })
  })
  it('refuses an unroutable host instead of widening it to every host', async () => {
    const local = fakeSearchService()
    setSessionSearchService(local)
    for (const scope of ['nope', 'ssh:', 'runtime:a|b']) {
      await expect(
        handlers.get('aiVault:searchSessions')!(null, { query: 'needle' }, scope)
      ).rejects.toThrow('not available for this execution host')
      await expect(handlers.get('aiVault:searchStatus')!(null, scope)).rejects.toThrow(
        'not available for this execution host'
      )
    }
    expect(local.search).not.toHaveBeenCalled()
    expect(local.status).not.toHaveBeenCalled()
    expect(sshSearch).not.toHaveBeenCalled()
    expect(runtimeSearch).not.toHaveBeenCalled()
  })

  it('merges every reachable host for `all` and keeps each transport redacted', async () => {
    setSessionSearchService({
      search: async () =>
        aiVaultSearchResults({
          hits: [aiVaultSearchHit({ sessionId: 'local-1', cwd: '/work/local' })],
          generation: 3
        }),
      status: async () => ({
        ...unavailableSessionSearchStatus(),
        enabled: true,
        generation: 3
      }),
      reconcile: async () => {}
    })
    sshHosts.mockReturnValue([{ targetId: 'ssh-host' }])
    sshSearch.mockResolvedValue(aiVaultSearchResults({ generation: 9 }))

    const result = await aiVaultApi.searchSessions({ query: 'needle' }, 'all')

    expect(sshSearch).toHaveBeenCalledWith('ssh-host', 'aiVault.searchSessions', {
      query: 'needle',
      limit: 100
    })
    expect(result).toMatchObject({
      kind: 'results',
      generation: 9,
      hosts: [
        { executionHostId: 'local', outcome: 'contributed' },
        { executionHostId: 'ssh:ssh-host', outcome: 'contributed' }
      ]
    })
    if (result.kind !== 'results') {
      throw new Error('expected results')
    }
    // Equal scores fall back to the host id, so this desktop sorts first.
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['local-1', 'host-session'])
    const [localHit, remoteHit] = result.hits
    expect(localHit?.source.filePath).toBe('/host/transcript.jsonl')
    expect(remoteHit?.source).toEqual({ presence: 'present' })
    expect(remoteHit?.resumeCommand).toBeUndefined()
  })

  it('aggregates host statuses for the `all` scope', async () => {
    setSessionSearchService({
      search: async () => aiVaultSearchResults(),
      status: async () => ({
        ...unavailableSessionSearchStatus(),
        enabled: true,
        filesIndexed: 4,
        generation: 3
      }),
      reconcile: async () => {}
    })
    sshHosts.mockReturnValue([{ targetId: 'ssh-host' }])
    sshSearch.mockResolvedValue({
      ...unavailableSessionSearchStatus(),
      enabled: true,
      filesIndexed: 6,
      generation: 9
    })

    expect(await aiVaultApi.searchStatus('all')).toMatchObject({
      enabled: true,
      filesIndexed: 10,
      generation: 9
    })
  })

  it('answers no-service for `all` when no host has an index', async () => {
    expect(await aiVaultApi.searchSessions({ query: 'needle' }, 'all')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
  })
})
