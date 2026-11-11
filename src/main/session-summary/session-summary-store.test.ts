import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSummaryStore, type SessionSummaryStoreEntry } from './session-summary-store'

const LEDGER = {
  goal: null,
  plan: [],
  inProgress: null,
  done: [],
  blockers: [],
  decisions: [],
  timeline: [],
  markers: [],
  reportSince: null,
  reportFull: null,
  lastUserMessageIndex: 1,
  userMessageCount: 2,
  foldedThrough: 2,
  foldedAt: null,
  foldGap: null,
  gaps: []
}

const ENTRY = {
  identity: { providerSessionId: 'p1', transcriptPath: '/tmp/p1.jsonl' },
  ledger: LEDGER,
  chunkCache: {},
  chunkFailures: {},
  messageCount: 2,
  seenThrough: 2,
  updatedAt: 1_700_000_000_000
} satisfies SessionSummaryStoreEntry

describe('SessionSummaryStore', () => {
  let directory: string

  const filePath = (): string => join(directory, 'session-summaries.json')
  const read = (): { version?: number; entries: Record<string, unknown> } =>
    JSON.parse(readFileSync(filePath(), 'utf8'))

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-summary-store-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  it('coalesces repeated writes into one, so a pane close does not rewrite the whole cache', () => {
    vi.useFakeTimers()
    const store = new SessionSummaryStore(filePath())
    for (let index = 0; index < 5; index++) {
      store.set(`pane:${index}`, { ...ENTRY, updatedAt: ENTRY.updatedAt + index })
    }
    // Nothing is on disk inside the debounce window: the point of coalescing.
    expect(() => read()).toThrow()

    vi.advanceTimersByTime(1_000)

    expect(Object.keys(read().entries)).toHaveLength(5)
  })

  it('flushes a queued write on demand, for a quit path or a reader', () => {
    const store = new SessionSummaryStore(filePath())
    store.set('pane', ENTRY)
    expect(() => read()).toThrow()

    store.flush()

    expect(read().entries.pane).toEqual(ENTRY)
    // A second flush has nothing to do, so it does not rewrite the file.
    const before = readFileSync(filePath())
    store.flush()
    expect(readFileSync(filePath())).toEqual(before)
  })

  it('writes through a per-writer temp name, not one shared temp', () => {
    const store = new SessionSummaryStore(filePath())
    store.set('pane', ENTRY)
    // A temp left by another writer must not be reused or read as this writer's output.
    writeFileSync(`${filePath()}.tmp`, 'another writer was here')
    store.flush()

    expect(read().entries.pane).toEqual(ENTRY)
    expect(readFileSync(`${filePath()}.tmp`, 'utf8')).toBe('another writer was here')
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([
      'session-summaries.json.tmp'
    ])
  })

  // A ledger written by a build whose chunk prompt carried one line per tool call, and whose
  // timeline was model output. Reusing it would fold the old, noisier reading of the same messages
  // and show a timeline no projection reproduces, so the version bump discards the whole cache.
  it('discards a store file written by an older ledger shape', () => {
    writeFileSync(
      filePath(),
      JSON.stringify({
        version: 3,
        entries: {
          pane: {
            ...ENTRY,
            ledger: { ...LEDGER, timelineBase: 0, foldedThrough: 900 }
          }
        }
      })
    )

    const store = new SessionSummaryStore(filePath())

    expect(store.get('pane')).toBeNull()
  })

  it('keeps every timeline entry, because the timeline is a projection and cannot outgrow them', () => {
    const store = new SessionSummaryStore(filePath())
    const timeline = Array.from({ length: 50 }, (_, index) => ({
      id: `e${index}`,
      kind: 'milestone' as const,
      text: `t${index}`,
      sourceIndex: index
    }))
    store.set('pane', {
      ...ENTRY,
      ledger: { ...LEDGER, timeline, foldedThrough: timeline.length }
    })
    store.flush()

    expect(store.get('pane')?.ledger.timeline).toEqual(timeline)
  })

  // An entry with a chunk cache but no ledger yet is a first fold in progress, not an empty summary:
  // dropping it is what made an interrupted first fold restart at event 0.
  it('keeps an entry whose fold has not produced a ledger yet', () => {
    const store = new SessionSummaryStore(filePath())
    store.set('pane', {
      ...ENTRY,
      chunkCache: { '0-120': { done: [{ text: 'half', sourceIndex: 3 }] } }
    })
    store.flush()

    expect(Object.keys(store.get('pane')?.chunkCache ?? {})).toEqual(['0-120'])
  })

  it('persists a deletion quickly enough for the next store to agree', () => {
    const store = new SessionSummaryStore(filePath())
    store.set('pane', ENTRY)
    store.flush()
    store.delete('pane')
    store.flush()

    expect(new SessionSummaryStore(filePath()).get('pane')).toBeNull()
  })
})
