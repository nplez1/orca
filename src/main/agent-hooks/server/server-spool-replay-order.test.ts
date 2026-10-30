import { describe, expect, it } from 'vitest'
import type { SpoolRecord } from '../../../shared/agent-hook-spool'
import { spoolReplayIsNewer } from './server-ingest-normalization'

/**
 * Why this rule exists: the startup spool replay runs before the listener binds, so every record it
 * sees predates any live event. A replay drained on a timer runs while hooks are live, and a record
 * the pane has already moved past would move it backwards — a timed-out prompt that a later `Stop`
 * superseded would flip the pane back to "working", which is the symptom the replay exists to fix.
 */
function record(receivedAt: number): SpoolRecord {
  return { paneKey: 'tab:leaf', source: 'claude', payload: {}, receivedAt }
}

describe('spool replay ordering', () => {
  it('accepts a record newer than the row the pane held when the drain started', () => {
    expect(spoolReplayIsNewer(record(2_000), 1_000)).toBe(true)
  })

  it('drops a record the pane has already moved past', () => {
    expect(spoolReplayIsNewer(record(1_000), 2_000)).toBe(false)
  })

  // The spool stamp is whole seconds, so an arrival inside the record's own second has to win.
  it('drops a record stamped in the same second as the row', () => {
    expect(spoolReplayIsNewer(record(1_000), 1_500)).toBe(false)
  })

  it('accepts when the pane held no row when the drain started', () => {
    expect(spoolReplayIsNewer(record(1_000), undefined)).toBe(true)
  })
})
