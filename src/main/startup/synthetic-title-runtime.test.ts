// The synthetic permission label carries no `π` marker, so overwriting pi's own state title
// switches off the ask-card lane's gate for the rest of the card's life (#226).

import { beforeEach, describe, expect, it, vi } from 'vitest'

type EnrichedListener = (event: Parameters<typeof driveSyntheticTitleFromHookStatus>[0]) => void

const hooks = vi.hoisted(() => {
  const enriched: EnrichedListener[] = []
  return { enriched, ingest: vi.fn() }
})
const titles = vi.hoisted(() => new Map<string, string>())

vi.mock('../ipc/pty/pane/key-state', () => ({
  registerPaneKeyTeardownListener: vi.fn(),
  getPtyIdForPaneKey: (paneKey: string) => (paneKey === 'pane-1' ? 'pty-1' : null)
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribePaneStatusClear: vi.fn(),
    subscribeStatusDrop: vi.fn(),
    subscribeEnrichedStatus: (listener: EnrichedListener) => {
      hooks.enriched.push(listener)
      return () => {}
    }
  }
}))

import { driveSyntheticTitleFromHookStatus } from './synthetic-title-runtime'
import { mainProcessState } from './main-process-state'

function status(
  state: 'working' | 'done' | 'waiting',
  agentType: string
): Parameters<EnrichedListener>[0] {
  return { paneKey: 'pane-1', payload: { state, agentType } }
}

beforeEach(() => {
  hooks.enriched.length = 0
  hooks.ingest.mockReset()
  titles.clear()
  mainProcessState.mainWindow = null
  mainProcessState.store = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: driveSyntheticTitle only reads these two runtime members.
  mainProcessState.runtime = {
    ingestSyntheticTitleFrame: hooks.ingest,
    getTrackedPtyTitle: (ptyId: string) => titles.get(ptyId) ?? null
  } as unknown as typeof mainProcessState.runtime
})

describe('synthetic titles over a pi state title', () => {
  it('rings the permission bell without restating the title', () => {
    // Why the bell alone: that extra BEL is what fires the permission notification, and the label it
    // would ride on carries no marker — the write that erased `π !` in the first place.
    titles.set('pty-1', 'π ! main')

    driveSyntheticTitleFromHookStatus(status('waiting', 'pi'))

    expect(hooks.ingest).toHaveBeenCalledTimes(1)
    expect(hooks.ingest.mock.calls[0][1]).toBe('\x07')
  })

  it('rings nothing for a finished turn over a pi state title', () => {
    titles.set('pty-1', 'π > main')

    driveSyntheticTitleFromHookStatus(status('done', 'pi'))

    expect(hooks.ingest).not.toHaveBeenCalled()
  })

  it('still labels a pi pane that holds no state marker of its own', () => {
    titles.set('pty-1', '⠋ π - main')

    driveSyntheticTitleFromHookStatus(status('waiting', 'pi'))

    expect(hooks.ingest).toHaveBeenCalledTimes(1)
    expect(hooks.ingest.mock.calls[0][0]).toBe('pty-1')
    expect(hooks.ingest.mock.calls[0][1]).toContain('Pi - action required')
  })

  // Why: the guard belongs to the `pi-compatible` identity group, so another agent's label over a
  // pi-shaped title is still delivered.
  it('labels a non-pi pane whatever its title looks like', () => {
    titles.set('pty-1', 'π ! main')

    driveSyntheticTitleFromHookStatus(status('waiting', 'hermes'))

    expect(hooks.ingest).toHaveBeenCalledTimes(1)
    expect(hooks.ingest.mock.calls[0][1]).toContain('Hermes - action required')
  })
})
