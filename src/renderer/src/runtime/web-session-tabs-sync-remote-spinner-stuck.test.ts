/**
 * Characterizes a remote paired pane's status lifecycle, for the reported "yellow spinner stuck
 * until restart" bug on a workspace of a PAIRED remote runtime.
 *
 * Setup (user report): the client's byte-derived pipeline can own agent status for the pane
 * (`shouldOwnAgentStatusInRenderer = runtimeEnvironmentId !== null`), so the client writes
 * `working` into agentStatusByPaneKey; the host later reports the agent `done`.
 *
 * What these tests pin: the client-authority fence DOES release past
 * AGENT_STATUS_STALE_AFTER_MS and the row DOES decay, so a stuck dot cannot be explained by the
 * fence alone (the first three cases); and a mirrored row the host projected without attribution
 * can never be swept by any snapshot (the last one, red before `agent-status-patch.ts` began
 * stamping the mirror's own worktree).
 *
 * The defect that actually pinned the dot lived one layer up — a cached pane title with no age of
 * its own, read by the title heuristic — and is pinned in `components/sidebar` and
 * `components/tab-bar` instead.
 *
 * This drives the same seam as the sibling suites: applyWebSessionTabsSnapshot
 * against a createTestStore, with the real client-authority fence
 * (registerRendererOwnedAgentStatusPane / markRendererOwnedAgentStatusWrite)
 * and fake clocks. The assertion is on the SIDEBAR outcome
 * (`selectWorktreeAgentActivitySummary(...).hasLiveWorking`), not just the raw
 * store field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { shouldApplyWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { selectWorktreeAgentActivitySummary } from '../components/sidebar/worktree-agent-activity-summary'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_SURFACE_ID = `${HOST_TAB_ID}::${LEAF_ID}`
const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)
const MIRROR_PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF_ID)
const HOST_PANE_KEY = makePaneKey(HOST_TAB_ID, LEAF_ID)
const T0 = 1_700_000_000_000
const CLIENT_PROMPT = 'Configurar y entender los comprobantes electronicos del sistema'

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  includeAgentStatus: boolean
  agentStatusOverrides?: Partial<AgentStatusEntry>
  omitAgentStatusAttribution?: boolean
}): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: HOST_SURFACE_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        ...(args.includeAgentStatus
          ? {
              agentStatus: {
                state: 'done' as const,
                prompt: '',
                updatedAt: args.hostNow,
                stateStartedAt: args.hostNow - 1_000,
                agentType: 'claude' as const,
                paneKey: HOST_PANE_KEY,
                ...(args.omitAgentStatusAttribution !== true
                  ? { tabId: HOST_TAB_ID, worktreeId: WT }
                  : {}),
                stateHistory: [],
                ...args.agentStatusOverrides
              }
            }
          : {})
      }
    ]
  }
}

function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): void {
  vi.setSystemTime(now)
  const state = store.getState()
  expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, now)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot patch is a partial of the slices this seeded test store defines, applied exactly as the sibling flap suite applies it.
  store.setState(patch as Partial<AppState>)
}

/** Replay what pty-connection.handleRendererOwnedAgentStatus does for a remote pane. */
function replayClientOscWorking(
  store: TestStore,
  clientNow: number,
  metadata?: { structuredHostOwned?: true }
): () => void {
  vi.setSystemTime(clientNow)
  const release = registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      MIRROR_PANE_KEY,
      { state: 'working', prompt: CLIENT_PROMPT, agentType: 'claude' },
      'claude',
      undefined,
      { tabId: MIRROR_TAB_ID, worktreeId: WT },
      metadata
    )
  return release
}

function seedPairedClientStore(): TestStore {
  const store = createTestStore()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: seedStore accepts a partial of the slices this seeded test store defines.
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: true
    },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WT
  } as Partial<AppState>)
  return store
}

function sidebarHasLiveWorking(store: TestStore, now: number): boolean {
  vi.setSystemTime(now)
  return selectWorktreeAgentActivitySummary(store.getState(), WT).hasLiveWorking
}

describe('remote paired pane: does a client "working" row clear past the stale boundary?', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('host publishes done: the client row reaches a terminal state and stops painting the yellow dot', () => {
    const store = seedPairedClientStore()
    replayClientOscWorking(store, T0)
    expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')
    expect(sidebarHasLiveWorking(store, T0)).toBe(true)

    // Host republishes `done` on a cadence well past the client row's freshness.
    for (let step = 1; step <= 4; step += 1) {
      const now = T0 + step * (AGENT_STATUS_STALE_AFTER_MS / 2) + (step >= 2 ? 1 : 0)
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 1 + step, hostNow: now, includeAgentStatus: true }),
        now
      )
    }

    const after = T0 + 2 * AGENT_STATUS_STALE_AFTER_MS + 1
    const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
    const fresh = entry
      ? isExplicitAgentStatusFresh(entry, after, AGENT_STATUS_STALE_AFTER_MS)
      : false
    // The reported bug: the row stays `working` forever, keeping the yellow dot.
    // A correct decay ends in `done` (terminal), never a fresh `working`.
    expect(entry?.state, 'client row must reach a terminal state').toBe('done')
    expect(fresh, 'a done row reads fresh by definition').toBe(true)
    expect(sidebarHasLiveWorking(store, after), 'yellow working dot must clear').toBe(false)
  })

  // Characterizes a known limitation, not a desired outcome: `buildMirroredAgentStatusPatch`
  // arbitrates across machines on `updatedAt`, so a host clock running behind leaves the raw row
  // non-terminal forever. The DOT still settles (the row is stale), and the dot is what the user
  // sees; pinned so a future fix has to change this deliberately.
  // Upstream's freshness guard on the retention fallback (kept by the 2026-10-30 merge) means a
  // stale client row no longer outlives the host's older-clock done. This still reads as skew —
  // the host's timestamp precedes the client's own write — but the host verdict now wins, which is
  // the fix the old version of this test was pinned to catch.
  it('cross-machine skew (client clock ahead): the host done still retires the stale client row', () => {
    const store = seedPairedClientStore()
    replayClientOscWorking(store, T0)

    // Host `done` is stamped on the HOST clock, which runs far behind the client's,
    // so the host's done timestamp precedes the client's working write (T0) even
    // though the agent really finished later. `buildMirroredAgentStatusPatch`
    // keeps `existing.updatedAt > entry.updatedAt` once the fence drops, so the
    // stale client row outlives every host done.
    for (let step = 1; step <= 4; step += 1) {
      const now = T0 + step * (AGENT_STATUS_STALE_AFTER_MS / 2) + (step >= 2 ? 1 : 0)
      const hostNow = T0 - 1_000
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 1 + step, hostNow, includeAgentStatus: true }),
        now
      )
    }

    const after = T0 + 2 * AGENT_STATUS_STALE_AFTER_MS + 1
    const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
    // The host's done retires the row even though its stamp is older than the client write.
    expect(entry?.state, 'host done retires the stale client row').toBe('done')
    expect(sidebarHasLiveWorking(store, after), 'yellow working dot clears').toBe(false)
  })

  it('host publishes nothing: the client row decays and the yellow dot clears', () => {
    const store = seedPairedClientStore()
    replayClientOscWorking(store, T0)
    expect(sidebarHasLiveWorking(store, T0)).toBe(true)

    // Host surface carries no agentStatus for this pane (hook-only host).
    for (let step = 1; step <= 4; step += 1) {
      const now = T0 + step * (AGENT_STATUS_STALE_AFTER_MS / 2) + (step >= 2 ? 1 : 0)
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 1 + step, hostNow: now, includeAgentStatus: false }),
        now
      )
    }

    const after = T0 + 2 * AGENT_STATUS_STALE_AFTER_MS + 1
    const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
    expect(entry, 'a client-owned row is retained, not deleted').toBeDefined()
    const fresh = isExplicitAgentStatusFresh(entry!, after, AGENT_STATUS_STALE_AFTER_MS)
    // Correct decay keeps the row but it reads stale, so consumers render idle.
    expect(fresh, 'retained working row must read stale').toBe(false)
    expect(sidebarHasLiveWorking(store, after), 'yellow working dot must clear').toBe(false)
  })
})

describe('remote paired pane: structuredHostOwned decay bypass (M1) and unattributed sweep escape (M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  // Deliberately NOT pinned: `structuredHostOwned: true` makes a non-done row fresh forever
  // (`shared/agent-status-freshness.ts:51`, mirrored at `lib/pane-agent-evidence.ts:33`). The flag
  // IS reachable — `native-chat/StructuredAgentSessionStatusBridge.tsx` sets it for a chat pane
  // whose execution the host owns — but those are chat panes that remove their own rows, not the
  // terminal-title trigger this suite covers, and the predicate is one the remote-flash fix
  // depends on. So the exemption is left alone rather than widened on an unreproduced shape.

  // The sweep gate `isMirroredAgentStatusOwnedBy` requires `entry.worktreeId === worktreeId`. The
  // host's synthetic `done` projection omits attribution, and the write path used to stamp only
  // `connectionId`, so a row the host projected that way could never be retired: it survived every
  // snapshot until the store reset on restart.
  it('sweeps a mirrored row the host projected without attribution', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow: T0,
        includeAgentStatus: true,
        omitAgentStatusAttribution: true,
        agentStatusOverrides: { state: 'working' }
      }),
      T0
    )
    const entry0 = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
    expect(entry0?.state).toBe('working')
    // The mirror stamps its own worktree, as it already stamped its own connection.
    expect(entry0?.worktreeId).toBe(WT)

    const after = T0 + AGENT_STATUS_STALE_AFTER_MS + 1
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 2, hostNow: after, includeAgentStatus: false }),
      after
    )

    const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
    expect(entry, 'mirrored row must be swept').toBeUndefined()
    // Without structuredHostOwned the leaked row still decays, so M2 alone does not pin the dot.
    expect(sidebarHasLiveWorking(store, after), 'yellow dot must clear').toBe(false)
  })
})
