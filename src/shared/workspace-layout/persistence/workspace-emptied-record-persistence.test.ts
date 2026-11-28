import { describe, expect, it } from 'vitest'
import { safeParseWorkspaceSession } from '../../workspace-session/workspace-session-schema'
import { getDefaultWorkspaceSession } from '../../orca-profiles/constants'
import { hasWorkspaceEmptiedRecord } from '../terminal-surfaces/closed-terminal-tab-tombstones'
import { applyWorkspaceSessionEntriesPatch } from '../../workspace-session/workspace-session-entries-patch'

const WT = 'repo1::/path/wt1'
const RECORD_ID = '2f6c1f9e-3e4a-4b0e-9b7d-2a1f4c6b8d10'
const NOW = 10_000

function sessionWith(records: Record<string, unknown>) {
  return { ...getDefaultWorkspaceSession(), closedTerminalTabTombstonesByTabId: records }
}

describe('a workspace-scoped emptied record', () => {
  it('survives the session schema, which is what makes it outlive a restart', () => {
    const parsed = safeParseWorkspaceSession(
      sessionWith({
        [RECORD_ID]: { closedAt: NOW, worktreeId: WT, reason: 'user', scope: 'workspace' }
      })
    )
    expect(parsed?.success).toBe(true)
    const records = parsed?.success ? parsed.data.closedTerminalTabTombstonesByTabId : undefined
    expect(records?.[RECORD_ID]).toEqual({
      closedAt: NOW,
      worktreeId: WT,
      reason: 'user',
      scope: 'workspace'
    })
    expect(hasWorkspaceEmptiedRecord(records, WT, NOW)).toBe(true)
  })

  it('keeps the record when a build that does not know its scope reads it', () => {
    // What an older build's schema does with a key it has no field for: drop the value, keep the
    // record. The workspace then reads as a plain closed tab, which is what it was before this.
    const parsed = safeParseWorkspaceSession(
      sessionWith({ [RECORD_ID]: { closedAt: NOW, worktreeId: WT, scope: 'surface' } })
    )
    const records = parsed?.success ? parsed.data.closedTerminalTabTombstonesByTabId : undefined
    expect(records?.[RECORD_ID]).toEqual({ closedAt: NOW, worktreeId: WT })
    expect(hasWorkspaceEmptiedRecord(records, WT, NOW)).toBe(false)
  })

  it('is not read for another workspace, or past the close-record TTL', () => {
    const records = {
      [RECORD_ID]: { closedAt: NOW, worktreeId: WT, scope: 'workspace' as const }
    }
    expect(hasWorkspaceEmptiedRecord(records, 'repo1::/path/other', NOW)).toBe(false)
    expect(hasWorkspaceEmptiedRecord(records, WT, NOW + 31 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  it('merges into the stored field as one entry, leaving the other records alone', () => {
    const stored = {
      ...getDefaultWorkspaceSession(),
      closedTerminalTabTombstonesByTabId: {
        'tab-1': { closedAt: NOW - 500, worktreeId: WT, reason: 'user' as const }
      }
    }
    const patch = applyWorkspaceSessionEntriesPatch(stored, {
      fields: {},
      entries: {
        closedTerminalTabTombstonesByTabId: {
          set: {
            [RECORD_ID]: { closedAt: NOW, worktreeId: WT, reason: 'user', scope: 'workspace' }
          },
          remove: []
        }
      }
    })
    const records = patch.closedTerminalTabTombstonesByTabId
    expect(records?.['tab-1']).toEqual({ closedAt: NOW - 500, worktreeId: WT, reason: 'user' })
    expect(records?.[RECORD_ID]).toEqual({
      closedAt: NOW,
      worktreeId: WT,
      reason: 'user',
      scope: 'workspace'
    })
  })
})
