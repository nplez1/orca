import { mkdtemp, rm, utimes, mkdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi, describe } from 'vitest'
import type {
  AiVaultScanProgress,
  AiVaultScanWork
} from '../../shared/ai-vault/scanning/ai-vault-scan-progress'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress,
  requestLocalAiVaultScan,
  resetLocalAiVaultScanProgressForTests,
  startLocalAiVaultScanProgress
} from './ai-vault-local-scan-progress'
import { AiVaultScannerServiceClient } from './scan-service/session-scanner-service-client'
import {
  AiVaultServiceTestChild,
  aiVaultServiceRequestId,
  readyAiVaultServiceChild
} from './scan-service/session-scanner-service-test-child'
import * as parseCache from './parse-cache/session-scanner-parse-cache'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { aiVaultScanWork, trackAiVaultScanProgress } from './ai-vault-scan-progress'
import { scanAiVaultSessions } from './session-scanner'
import { resetSessionParseCacheForTests } from './parse-cache/session-parse-cache-store'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

// Source fixtures exercise the real SQLite readers without a packaged worker bundle.
vi.mock(
  './scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async () => {
    const { listOpenCodeSqliteSessions } =
      await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite-list')
    const { listOpenCode2SqliteSessions } =
      await import('./scanners/opencode2/session-scanner-opencode2-sqlite-list')
    const { parseOpenCodeSqliteSession } =
      await import('./scanners/opencode/sqlite/session-scanner-opencode-sqlite')
    return {
      listOpenCode2SqliteSessionsViaWorker: listOpenCode2SqliteSessions,
      listOpenCodeSqliteSessionsViaWorker: listOpenCodeSqliteSessions,
      listZcodeSqliteSessionsViaWorker: (args: Parameters<typeof listOpenCodeSqliteSessions>[0]) =>
        listOpenCodeSqliteSessions({ ...args, agent: 'zcode' }),
      parseOpenCodeSqliteSessionViaWorker: parseOpenCodeSqliteSession
    }
  }
)

let tempRoot: string | null = null

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  resetLocalAiVaultScanProgressForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

async function scanInChild(
  limit = 20
): Promise<{ reports: AiVaultScanWork[]; final: AiVaultScanWork }> {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-strip-'))
  const roots = isolatedScanRoots(tempRoot)
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const path = join(roots.claudeProjectsDir, 'project', `${name}.jsonl`)
    await writeJsonlFile(path, [
      {
        type: 'user',
        sessionId: name,
        timestamp: '2026-05-01T10:00:00.000Z',
        cwd: '/tmp/claude',
        message: { role: 'user', content: `ask ${name}` }
      }
    ])
    await utimes(path, 1_000 + index, 1_000 + index)
  }
  // Codex homes and linked profiles can expose hardlinks to the same transcript.
  await mkdir(join(roots.claudeProjectsDir, 'linked'))
  await link(
    join(roots.claudeProjectsDir, 'project', 'a.jsonl'),
    join(roots.claudeProjectsDir, 'linked', 'a.jsonl')
  )
  const signal = new AbortController().signal
  const reports: AiVaultScanWork[] = []
  let now = 0
  trackAiVaultScanProgress(
    signal,
    (work) => reports.push(work),
    () => (now += 1_000)
  )
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit, signal })
  return { reports, final: aiVaultScanWork(signal)! }
}

function startScan(): {
  child: AiVaultServiceTestChild
  client: AiVaultScannerServiceClient
  scan: Promise<{ work: AiVaultScanWork | null }>
  published: (AiVaultScanProgress | null)[]
} {
  const child = new AiVaultServiceTestChild()
  const client = new AiVaultScannerServiceClient({
    processFactory: () => child.asChildProcess(),
    init: () => ({ sessionParseCache: null, sessionSearch: null })
  })
  const published: (AiVaultScanProgress | null)[] = []
  onLocalAiVaultScanProgress(({ progress }) => published.push(progress))
  const scan = requestLocalAiVaultScan(
    (listener) =>
      client.request<{ work: AiVaultScanWork | null }>(
        { type: 'request', operation: 'scan', options: {} },
        undefined,
        listener
      ),
    { now: () => 5_000 }
  )
  return { child, client, scan, published }
}

describe('Session History scanner totals and service-client progress state', () => {
  it('counts distinct files while walking, then reads, and publishes the finished totals', async () => {
    const { reports, final } = await scanInChild()
    expect(reports.some((work) => work.stage === 'finding')).toBe(true)
    expect(final).toMatchObject({
      stage: 'reading',
      agents: [
        {
          agent: 'claude',
          files: 3,
          databases: 0,
          walking: false,
          read: { done: 4, total: 4, skipped: 0 }
        }
      ],
      read: { done: 4, total: 4, skipped: 0 }
    })
    // Every parse has ended, so the scan must not leave a stale in-flight path behind: a later
    // fault would blame a file that already closed.
    expect(final.readingFiles).toBeUndefined()

    const { child, scan, published } = startScan()
    readyAiVaultServiceChild(child)
    await vi.waitFor(() => expect(localAiVaultScanProgress('')?.stage).toBe('finding'))
    const id = aiVaultServiceRequestId(child, 'scan')
    child.emit('message', { type: 'progress', id, work: reports[0] })
    child.emit('message', {
      type: 'result',
      id,
      operation: 'scan',
      value: { result: { sessions: [], issues: [], scannedAt: '' }, durationMs: 1, work: final }
    })
    await scan

    expect(published.map((progress) => progress?.stage ?? null)).toEqual([
      'finding',
      reports[0]!.stage,
      'finished'
    ])
    expect(localAiVaultScanProgress('')).toEqual({
      ...final,
      scanId: '',
      stage: 'finished',
      startedAt: 5_000,
      settledAt: 5_000
    })
  })

  it('publishes nothing for an answer that carries no tally, because no scan ran', async () => {
    const { child, scan, published } = startScan()
    readyAiVaultServiceChild(child)
    await vi.waitFor(() => expect(localAiVaultScanProgress('')?.stage).toBe('finding'))
    const id = aiVaultServiceRequestId(child, 'scan')
    // What the fork's index-first path returns: the host listed from its index, so it has no
    // work to report. A finished row here would render as "Scanned 0 files".
    child.emit('message', {
      type: 'result',
      id,
      operation: 'scan',
      value: { result: { sessions: [], issues: [], scannedAt: '' }, durationMs: 1, work: null }
    })
    await scan

    expect(published.map((progress) => progress?.stage ?? null)).toEqual(['finding', null])
    expect(localAiVaultScanProgress('')).toBeNull()
  })

  it('keeps a replacement entry when the scan it replaced fails late', () => {
    const earlier = startLocalAiVaultScanProgress('scope', 'earlier', () => 500)
    // A finish that never reported work publishes nothing, so the fallback this test reads
    // back has to be a scan that really ran.
    earlier.work({ stage: 'reading', agents: [], read: { done: 1, total: 1 } })
    earlier.finish(null)
    const old = startLocalAiVaultScanProgress('scope', 'old', () => 1_000)
    const replacement = startLocalAiVaultScanProgress('scope', 'replacement', () => 2_000)
    old.fail()
    expect(localAiVaultScanProgress('scope')).toMatchObject({ stage: 'finding', startedAt: 2_000 })

    replacement.fail()
    expect(localAiVaultScanProgress('scope')).toMatchObject({
      scanId: 'earlier',
      stage: 'finished'
    })
  })

})

it.each(['cutoff', 'bucket', 'filtered'] as const)(
  'freezes %s work without changing cold/warm execution',
  async (flow) => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-frozen-'))
    const roots = isolatedScanRoots(tempRoot)
    for (let index = 0; index < (flow === 'filtered' ? 27 : 6); index++) {
      const timestamp = new Date(Date.UTC(2026, 9, 19) - index * 60_000).toISOString()
      const cwd =
        index >= 3 && (flow === 'bucket' || (index - 3) % 8 === 0) ? '/repo' : '/elsewhere'
      const path =
        flow === 'filtered'
          ? join(roots.codexSessionsDir, `rollout-${index}.jsonl`)
          : join(
              roots.claudeProjectsDir,
              cwd === '/repo' ? '-repo' : '-elsewhere',
              `${index}.jsonl`
            )
      await writeJsonlFile(
        path,
        flow === 'filtered'
          ? [
              { timestamp, type: 'session_meta', payload: { id: `fixture-${index}`, cwd } },
              {
                timestamp,
                type: 'event_msg',
                payload: { type: 'user_message', message: `Generated ${index}` }
              }
            ]
          : [
              {
                type: 'user',
                sessionId: `fixture-${index}`,
                timestamp,
                cwd,
                message: { role: 'user', content: `Generated ${index}` }
              }
            ]
      )
      await utimes(path, Date.parse(timestamp) / 1000, Date.parse(timestamp) / 1000)
    }
    const listed = vi.spyOn(parseCache, 'parseListedSessionFile')
    const walked = vi.spyOn(parseCache, 'parseAgentSessionFileCached')
    const stats = vi.spyOn(parseCache, 'createSessionParseStats')
    const opened = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
    const ids =
      flow === 'cutoff'
        ? [0, 1, 2]
        : flow === 'filtered'
          ? [0, 1, 2, 3, 11, 19]
          : [0, 1, 2, 3, 4, 5]
    for (const warm of [false, true]) {
      const reports: AiVaultScanWork[] = []
      const signal = new AbortController().signal
      let now = 0
      const stop = trackAiVaultScanProgress(
        signal,
        (work) => reports.push(work),
        () => (now += 1000)
      )
      try {
        const result = await scanAiVaultSessions({
          ...roots,
          platform: 'darwin',
          limit: 3,
          limitPerAgent: 50,
          signal,
          ...(flow === 'cutoff' ? {} : { scopePaths: ['/repo'] })
        })
        expect(result.issues).toEqual([])
        expect(result.sessions.map((row) => row.sessionId)).toEqual(
          ids.map((id) => `fixture-${id}`)
        )
        const attempts = [...listed.mock.calls, ...walked.mock.calls].map(
          ([candidate]) => candidate.file.path
        )
        expect(
          attempts.map((path) =>
            Number(basename(path).replace('rollout-', '').replace('.jsonl', ''))
          )
        ).toEqual(ids)
        expect(opened.mock.calls).toHaveLength(warm ? 0 : flow === 'bucket' ? 7 : ids.length)
        expect(stats.mock.results.at(-1)?.value).toEqual({
          reused: warm ? ids.length : 0,
          incremental: 0,
          fullParses: warm ? 0 : ids.length,
          earlyStopped: 0,
          bytesRead: warm ? 0 : flow === 'filtered' ? 1363 : flow === 'bucket' ? 873 : 444
        })
        const reading = reports.filter((work) => work.stage === 'reading')
        const total = flow === 'filtered' ? 27 : 6
        let settled = 0
        for (const work of reading) {
          expect(work.read.total).toBe(total)
          expect(work.read.done + (work.read.skipped ?? 0)).toBeGreaterThanOrEqual(settled)
          settled = work.read.done + (work.read.skipped ?? 0)
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.total ?? 0), 0)).toBe(total)
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.done ?? 0), 0)).toBe(
            work.read.done
          )
          expect(work.agents.reduce((sum, agent) => sum + (agent.read?.skipped ?? 0), 0)).toBe(
            work.read.skipped
          )
        }
        expect(aiVaultScanWork(signal)?.read).toEqual({
          done: ids.length,
          total,
          skipped: total - ids.length
        })
      } finally {
        stop()
      }
      listed.mockClear()
      walked.mockClear()
      opened.mockClear()
    }
  }
)

it('does not settle a batch interrupted during its real parser invocation', async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-scan-abort-'))
  const roots = isolatedScanRoots(tempRoot)
  await writeJsonlFile(join(roots.claudeProjectsDir, 'project', 'a.jsonl'), [
    { type: 'user', sessionId: 'a', message: { role: 'user', content: 'Generated' } }
  ])
  const controller = new AbortController()
  const original = parseCache.parseListedSessionFile
  vi.spyOn(parseCache, 'parseListedSessionFile').mockImplementation(async (...args) => {
    const result = await original(...args)
    controller.abort()
    return result
  })
  const stop = trackAiVaultScanProgress(controller.signal, () => undefined)
  try {
    await expect(
      scanAiVaultSessions({ ...roots, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(aiVaultScanWork(controller.signal)?.read).toEqual({ done: 0, total: 1, skipped: 0 })
  } finally {
    stop()
  }
})
