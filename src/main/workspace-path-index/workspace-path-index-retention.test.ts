import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'
import { WorkspacePathIndexRetention } from './workspace-path-index-retention'

/** Why: the last root a session closes used to keep its catalog until some other lease released. */

const RETENTION_MS = 5 * 60_000

function entry(key: string, lastUsedAt: number): WorkspacePathIndexEntry {
  // SAFETY: retention reads only `key`, `leases`, and `lastUsedAt`; the rest is unreachable here.
  return {
    key,
    owner: {},
    leases: new Set<string>(),
    lastUsedAt
  } as unknown as WorkspacePathIndexEntry
}

function harness(): {
  entries: Map<string, WorkspacePathIndexEntry>
  retention: WorkspacePathIndexRetention
  disposed: string[]
} {
  const entries = new Map<string, WorkspacePathIndexEntry>()
  const disposed: string[] = []
  const retention = new WorkspacePathIndexRetention(entries, 8, RETENTION_MS, (disposedEntry) => {
    disposed.push(disposedEntry.key)
    entries.delete(disposedEntry.key)
  })
  return { entries, retention, disposed }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WorkspacePathIndexRetention', () => {
  it('expires the last closed root on its own timer, with no further release', () => {
    vi.useFakeTimers()
    const { entries, retention, disposed } = harness()
    entries.set('root-a', entry('root-a', Date.now()))

    retention.afterRelease()
    expect(disposed).toEqual([])

    vi.advanceTimersByTime(RETENTION_MS + 1)

    expect(disposed).toEqual(['root-a'])
    expect(entries.size).toBe(0)
  })

  it('keeps a root that still holds a lease past its timer', () => {
    vi.useFakeTimers()
    const { entries, retention, disposed } = harness()
    const leased = entry('root-b', Date.now())
    leased.leases.add('lease-1')
    entries.set('root-b', leased)

    retention.afterRelease()
    vi.advanceTimersByTime(RETENTION_MS * 2)

    expect(disposed).toEqual([])
  })

  it('stops expiring once disposed', () => {
    vi.useFakeTimers()
    const { entries, retention, disposed } = harness()
    entries.set('root-c', entry('root-c', Date.now()))

    retention.afterRelease()
    retention.dispose()
    vi.advanceTimersByTime(RETENTION_MS + 1)

    expect(disposed).toEqual([])
  })
})
