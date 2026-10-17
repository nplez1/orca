import { beforeEach, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultSessionKeyScopePaths } from './ai-vault-session-limit'
import {
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList
} from './ai-vault-session-list-request'
import {
  aiVaultSessionResultCacheKey,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'

function session(sessionId: string): AiVaultSession {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/repo/app',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-07-04T01:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

function request(scopePath: string, sessionLimit: 'unlimited' | number) {
  return { executionHostScope: 'local' as const, scopePaths: [scopePath], sessionLimit }
}

beforeEach(() => {
  resetAiVaultSessionResultCacheForTest()
})

// Why: at Unlimited every scope's rows are already in the answer, so a key that still
// names one splits an identical list per project — and refetches it on every switch.
it('drops the scope at Unlimited and keeps it at a finite depth', () => {
  expect(aiVaultSessionKeyScopePaths(['/repo/app'], 'unlimited')).toEqual([])
  expect(aiVaultSessionKeyScopePaths(['/repo/app'], 250)).toEqual(['/repo/app'])
})

it('serves a second project from the Unlimited listing already cached', () => {
  const loaded = { sessions: [session('a')], issues: [], scannedAt: '2026-07-04T01:00:00.000Z' }
  cacheAiVaultSessionList(request('/repo/app', 'unlimited'), loaded, { replaceHostEntries: false })

  expect(readCachedAiVaultSessionList(request('/repo/other', 'unlimited'))).not.toBeNull()
  // Unlimited holds every depth, so narrowing to a preset is served from it too.
  expect(readCachedAiVaultSessionList(request('/repo/app', 250))).not.toBeNull()
})

it('still stores a fresher bounded list after the unbounded one answered it', () => {
  const loaded = { sessions: [session('old')], issues: [], scannedAt: '2026-08-01T00:00:00.000Z' }
  cacheAiVaultSessionList(request('/repo/app', 'unlimited'), loaded, { replaceHostEntries: false })
  // Served from the unbounded entry, which must not leave a copy behind on this key.
  expect(readCachedAiVaultSessionList(request('/repo/app', 250))?.scannedAt).toBe(
    '2026-08-01T00:00:00.000Z'
  )

  const fresh = { sessions: [session('new')], issues: [], scannedAt: '2026-08-01T00:00:09.000Z' }
  cacheAiVaultSessionList(request('/repo/app', 250), fresh, { replaceHostEntries: false })

  expect(readCachedAiVaultSessionList(request('/repo/app', 250))?.scannedAt).toBe(
    '2026-08-01T00:00:09.000Z'
  )
})

it('keeps one project apart from another at a finite depth', () => {
  const loaded = { sessions: [session('a')], issues: [], scannedAt: '2026-07-04T01:00:00.000Z' }
  cacheAiVaultSessionList(request('/repo/app', 250), loaded, { replaceHostEntries: false })

  expect(aiVaultSessionResultCacheKey('local', ['/repo/app'], 250)).not.toBe(
    aiVaultSessionResultCacheKey('local', ['/repo/other'], 250)
  )
  // A bounded listing is its own answer, so another project must not inherit it.
  expect(readCachedAiVaultSessionList(request('/repo/other', 250))).toBeNull()
})
