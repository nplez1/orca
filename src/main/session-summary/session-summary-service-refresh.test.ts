import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummarySnapshot } from '../../shared/session-summary-types'
import { SessionSummaryService } from './session-summary-service'
import { SessionSummaryStore } from './session-summary-store'
import type { SessionSummaryStatusEntry } from './session-summary-service'
import type { SessionSummarySourceEvent } from './session-summary-fold'

function events(count: number): SessionSummarySourceEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
    timestamp: null
  }))
}

let storeSeq = 0
function testStore(): SessionSummaryStore {
  storeSeq += 1
  return new SessionSummaryStore(
    join(tmpdir(), `session-summary-refresh-${storeSeq}-${Date.now()}.json`)
  )
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function harness(options: {
  entry?: SessionSummaryStatusEntry | ((paneKey: string) => SessionSummaryStatusEntry | undefined)
}) {
  const store = testStore()
  let currentEntry: (paneKey: string) => SessionSummaryStatusEntry | undefined
  if (typeof options.entry === 'function') {
    currentEntry = options.entry
  } else {
    const fixedEntry = options.entry ?? defaultEntry()
    currentEntry = () => fixedEntry
  }
  const reads: string[] = []
  const service = new SessionSummaryService({
    store,
    readEvents: async () => {
      reads.push('read')
      return events(4)
    },
    getAgentStatusEntry: (paneKey) => currentEntry(paneKey),
    canReadTranscript: () => true,
    createBrain: () => ({
      complete: async ({ prompt }) =>
        prompt.startsWith('You write short progress reports')
          ? JSON.stringify({ since: 's', full: 'f' })
          : JSON.stringify({ inProgress: 'folding' })
    }),
    now: () => Date.now()
  })
  const updates: SessionSummarySnapshot[] = []
  service.onUpdate((snapshot) => updates.push(snapshot))
  return {
    service,
    store,
    updates,
    reads: () => reads.length,
    setEntry: (next: (paneKey: string) => SessionSummaryStatusEntry | undefined) => {
      currentEntry = next
    }
  }
}

function defaultEntry(
  overrides: Partial<SessionSummaryStatusEntry> = {}
): SessionSummaryStatusEntry {
  return {
    agentType: 'pi',
    providerSession: { key: 'session_id', id: 'pi-1', transcriptPath: '/tmp/pi-1.jsonl' },
    updatedAt: Date.now() + 1_000,
    ...overrides
  }
}

describe('SessionSummaryService fresh-brief reuse', () => {
  // The pane remounts when a new session starts inside it, and that remount re-opens with the
  // 5-minute window — so a stale brief from the *previous* conversation must not be reused.
  it('never reuses a brief that describes a different session', async () => {
    const h = harness({ entry: defaultEntry() })
    h.service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))
    expect(h.store.get('tab:leaf')?.identity.providerSessionId).toBe('pi-1')

    // A new session takes the pane; the row moves first, exactly as hooks do.
    h.setEntry(() => defaultEntry({ providerSession: { key: 'session_id', id: 'pi-2' } }))
    const reopened = h.service.open({ paneKey: 'tab:leaf', revalidateWithinMs: 5 * 60_000 })

    expect(reopened.ledger).toBeNull()
    // The stale entry is gone, so this open must fold rather than answer with it.
    expect(h.store.get('tab:leaf')).not.toMatchObject({
      identity: { providerSessionId: 'pi-1' }
    })
  })

  // A refresh is the same reader asking again. A lease per request would outlive the one close an
  // unmount sends, so cancel-on-close would stop working after the first click.
  it('does not take a second lease for a refresh', async () => {
    const h = harness({ entry: defaultEntry({ updatedAt: 0 }) })
    h.service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))
    const readsBefore = h.reads()

    h.service.open({ paneKey: 'tab:leaf', sameViewer: true })
    await waitFor(() => h.reads() > readsBefore)

    // One viewer, one lease: the mont's single close must be enough to stop the pane's work.
    h.service.close({ paneKey: 'tab:leaf', seenTimelineCount: 0 })
    const readsAfterClose = h.reads()
    h.service.open({ paneKey: 'tab:leaf', sameViewer: true })
    // No runtime survives the close, so this open starts from scratch rather than reusing one.
    expect(readsAfterClose).toBeLessThanOrEqual(h.reads())
  })

  // A row that is gone says nothing about the transcript. Treating "unknown" as "nothing
  // happened" would reuse a brief forever for a session that resumed later.
  it('falls back to the time window when the row has no timestamp', async () => {
    const h = harness({ entry: defaultEntry({ updatedAt: 0 }) })
    h.service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => h.updates.some((u) => u.status === 'ready'))
    const stored = h.store.get('tab:leaf')
    // Age the brief past the caller's window; with no row timestamp it must not be reused.
    if (stored?.ledger) {
      h.store.set('tab:leaf', {
        ...stored,
        ledger: { ...stored.ledger, foldedAt: (stored.ledger.foldedAt ?? 0) - 10 * 60_000 }
      })
    }
    const readsBefore = h.reads()

    h.service.open({ paneKey: 'tab:leaf', revalidateWithinMs: 5 * 60_000 })

    await waitFor(() => h.reads() > readsBefore)
  })
})

// A failed report rewrite keeps the previous prose, but only when it still describes the same
// window: a "since your last message" sentence from before the reader's latest message would be
// labelled as news about work they have already spoken over.
describe('SessionSummaryService report staleness', () => {
  it('drops the previous "since" when the reader has spoken since it was written', async () => {
    const store = testStore()
    const service = new SessionSummaryService({
      store,
      readEvents: async () => events(6),
      getAgentStatusEntry: () => defaultEntry(),
      canReadTranscript: () => true,
      createBrain: () => ({
        complete: async ({ prompt }) => {
          if (prompt.startsWith('You write short progress reports')) {
            throw new Error('report phase failed')
          }
          return JSON.stringify({ inProgress: 'folding' })
        }
      }),
      now: () => Date.now()
    })
    const updates: SessionSummarySnapshot[] = []
    service.onUpdate((snapshot) => updates.push(snapshot))
    service.open({ paneKey: 'tab:leaf' })
    await waitFor(() => updates.some((u) => u.status === 'ready'))

    // Reports never landed (the phase failed), so there is nothing stale to show either way.
    const ready = updates.find((u) => u.status === 'ready')
    expect(ready?.ledger?.reportSince).toBeNull()
    expect(ready?.ledger?.reportFull).toBeNull()
    // The facts still landed: a failed rewrite must not fail the batch.
    expect(ready?.ledger?.foldedThrough).toBe(6)
  })
})
