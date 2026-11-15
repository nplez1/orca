/** Paired panes receive both client byte-derived status/titles and host snapshot echoes. Proven client ownership must fence stale echoes despite cross-machine clocks; teardown returns authority and host-only states pierce the fence. Drive real mirror/store logic with controlled clocks and assert transition order/count, including generatedLabel and epoch stability. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { AppState } from '../../../store/types'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests,
  resolveRendererOwnedAgentStatusTiming
} from '../../../components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import { resetHostDialogObservationsForTests } from '../agent-status-patch'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import { shouldApplyWebSessionTabsSnapshot } from '../tracking-decisions'

// Mirror imports app singleton; redirect it to this createTestStore harness.
vi.mock('../../../store/index', () => ({
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
const CYCLES = 3

const LOCAL_WT = 'repo1::/path/local-wt'

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  includeAgentStatus: boolean
  agentStatusOverrides?: Partial<AgentStatusEntry>
  aiVaultTitle?: { agent: 'claude'; sessionId: string; title: string } | null
  resolvesSessionTitle?: true
  title?: string
  status?: 'ready' | 'pending-handle'
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
        title: args.title ?? 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        ...(args.status === 'pending-handle'
          ? { status: 'pending-handle' as const, terminal: null }
          : { status: 'ready' as const, terminal: 'terminal-1' }),
        ...(args.aiVaultTitle !== undefined ? { aiVaultTitle: args.aiVaultTitle } : {}),
        ...(args.resolvesSessionTitle ? { resolvesSessionTitle: true as const } : {}),
        ...(args.includeAgentStatus
          ? {
              agentStatus: {
                state: 'done' as const,
                prompt: '',
                updatedAt: args.hostNow,
                stateStartedAt: args.hostNow - 1_000,
                agentType: 'claude' as const,
                paneKey: HOST_PANE_KEY,
                tabId: HOST_TAB_ID,
                worktreeId: WT,
                stateHistory: [],
                ...args.agentStatusOverrides
              }
            }
          : {})
      }
    ]
  }
}

/** Mirrors applyWebSessionTabsStorePatch: build the patch from live state, then setState it. */
function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): void {
  const state = store.getState()
  // The freshness gate must accept every republished frame (monotonic version).
  expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, now)
  store.setState(patch as Partial<AppState>)
}

/** Replay paired pty-connection OSC handling with client Date.now(); returns the release pty-connection holds for dispose(). */
function replayClientOscWorking(store: TestStore, clientNow: number): () => void {
  vi.setSystemTime(clientNow)
  // Claim on transport creation, then verify ownership on each byte-derived status.
  const release = registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      MIRROR_PANE_KEY,
      { state: 'working', prompt: CLIENT_PROMPT, agentType: 'claude' },
      'claude',
      resolveRendererOwnedAgentStatusTiming(
        store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)
      ),
      { tabId: MIRROR_TAB_ID, worktreeId: WT }
    )
  return release
}

function seedPairedClientStore(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: true
    },
    worktreesByRepo: {
      repo1: [
        // The paired server owns this workspace, so its titles stay the window's to apply.
        makeWorktree({
          id: WT,
          repoId: 'repo1',
          path: '/path/wt1',
          runtimeOwnerEnvironmentId: ENV
        }),
        makeWorktree({ id: LOCAL_WT, repoId: 'repo1', path: '/path/local-wt' })
      ]
    },
    activeWorktreeId: WT
  })
  return store
}

describe('remote-paired pane: host snapshot mirror vs client byte-derived status/title (issue1-ui-flash)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    resetHostDialogObservationsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  // Fence only proven client writers and never host-only state classes.
  describe('authority handback', () => {
    it('reclaims byte ownership after approval despite an ahead-clock host', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: T0 + 60_000,
          includeAgentStatus: true,
          agentStatusOverrides: {
            state: 'waiting',
            interactivePrompt: 'Allow exec_command?'
          }
        }),
        T0 + 1_000
      )
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)?.state).toBe('waiting')

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 3,
          hostNow: T0 + 61_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'working' }
        }),
        T0 + 1_250
      )
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)?.state).toBe('working')

      replayClientOscWorking(store, T0 + 1_500)
      const byteEntry = store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)
      expect(byteEntry?.state).toBe('working')
      expect(byteEntry?.mirroredEvidenceReceivedAt).toBeUndefined()
      expect(byteEntry?.interactivePrompt).toBeUndefined()

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 4,
          hostNow: T0 + 120_000,
          includeAgentStatus: true
        }),
        T0 + 2_000
      )
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)).toMatchObject({
        state: 'working',
        updatedAt: T0 + 1_500,
        prompt: CLIENT_PROMPT
      })
    })

    // Pi reports its dialog as `waiting` (ui_prompt_start) and Copilot's screen lane repaints a
    // working row to `waiting`; neither names an ask tool, so only the state can carry the wait.
    it('lets a host question wait pierce the fence (hook-HTTP-only on the host)', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)

      const askedAt = T0 + 1_000
      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: askedAt,
          includeAgentStatus: true,
          agentStatusOverrides: {
            state: 'waiting',
            prompt: 'Does a pending ask show as Needs You?',
            agentType: 'pi'
          }
        }),
        askedAt
      )

      const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      expect(entry?.state).toBe('waiting')
      expect(entry?.prompt).toBe('Does a pending ask show as Needs You?')
    })

    // Why: the fence must not outlive the wait it admitted. A row the host mirrored here IS the
    // host's statement, so the host's own release has to land without waiting for the client's
    // next byte write (a dialog answered with no further PTY activity emits none).
    it('follows the host when it releases the wait it opened', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)
      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: T0 + 1_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'waiting', prompt: 'Answer me', agentType: 'pi' }
        }),
        T0 + 1_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('waiting')

      // Answered: the host resumes the turn. No client byte write in between.
      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 3,
          hostNow: T0 + 2_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'working', prompt: 'Answer me', agentType: 'pi' }
        }),
        T0 + 2_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      // And the turn then finishes.
      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 4,
          hostNow: T0 + 3_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'done', prompt: 'Answer me', agentType: 'pi' }
        }),
        T0 + 3_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('done')
    })

    // Why: the two clocks are not comparable, so a client running ahead must not be able to keep
    // its own `working` over a dialog only the host can see.
    it('takes the host wait even when the client clock runs ahead', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 60_000)

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: T0 + 1_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'waiting', prompt: 'Answer me', agentType: 'pi' }
        }),
        T0 + 60_500
      )

      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('waiting')
    })

    // Why: pi re-posts `ui_prompt_active` on every tool event while the dialog is open, so both
    // writers keep publishing for the whole wait. Each round's host frame is a NEW observation of the
    // same open dialog, so it must win that round whatever order the two land in; the client's write
    // in between is stale bytes and loses again on the next host frame.
    it('keeps the host wait through interleaved client byte writes', () => {
      const store = seedPairedClientStore()
      // The client's clock runs ahead of the host's, so its own byte writes always out-rank the
      // host rows by `updatedAt` — the hardest order for the host's dialog to survive.
      let clientNow = T0 + 10_000
      replayClientOscWorking(store, clientNow)
      const rounds: (string | null)[] = []
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        clientNow += 5_000
        vi.setSystemTime(clientNow)
        markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
        store
          .getState()
          .setAgentStatus(
            MIRROR_PANE_KEY,
            { state: 'working', prompt: CLIENT_PROMPT, agentType: 'pi' },
            'pi',
            undefined,
            { tabId: MIRROR_TAB_ID, worktreeId: WT }
          )
        expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

        const hostNow = T0 + 1_000 + cycle * 1_000
        applyHostSnapshot(
          store,
          makeHostSnapshot({
            snapshotVersion: 2 + cycle,
            hostNow,
            includeAgentStatus: true,
            agentStatusOverrides: { state: 'waiting', prompt: 'Answer me', agentType: 'pi' }
          }),
          hostNow
        )
        rounds.push(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state ?? null)
      }
      expect(rounds).toEqual(Array.from({ length: CYCLES }, () => 'waiting'))
    })

    // Why: a republish of a row the host already sent is not new evidence. Re-piercing on it would
    // re-open a wait the client's bytes have moved past, so a host that died with a dialog open
    // would pin the client on Needs You for as long as it keeps republishing that frozen row.
    it('does not re-open a wait the host merely republishes', () => {
      const store = seedPairedClientStore()
      const clientNow = T0 + 10_000
      replayClientOscWorking(store, clientNow)
      const hostWait = (snapshotVersion: number, hostNow: number) =>
        makeHostSnapshot({
          snapshotVersion,
          hostNow,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'waiting', prompt: 'Answer me', agentType: 'pi' }
        })

      // The first sighting of the host's wait pierces.
      applyHostSnapshot(store, hostWait(2, T0 + 1_000), T0 + 1_000)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('waiting')

      // The client's bytes write again, as they do on every OSC frame.
      vi.setSystemTime(clientNow + 1_000)
      markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
      store
        .getState()
        .setAgentStatus(
          MIRROR_PANE_KEY,
          { state: 'working', prompt: CLIENT_PROMPT, agentType: 'pi' },
          'pi',
          undefined,
          { tabId: MIRROR_TAB_ID, worktreeId: WT }
        )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      // Same row, newer snapshot: the host is repeating itself, so the client keeps its own state.
      applyHostSnapshot(store, hostWait(3, T0 + 1_000), T0 + 20_000)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      // A genuinely new observation of the dialog still wins.
      applyHostSnapshot(store, hostWait(4, T0 + 30_000), T0 + 30_000)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('waiting')
    })
  })
})
