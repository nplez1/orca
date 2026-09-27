import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  recordMock,
  drainSpawnsMock,
  setAttributionMock,
  getLifecycleMarkersMock,
  clearLifecycleMarkersMock
} = vi.hoisted(() => ({
  recordMock: vi.fn(),
  drainSpawnsMock: vi.fn(),
  setAttributionMock: vi.fn(),
  getLifecycleMarkersMock: vi.fn(),
  clearLifecycleMarkersMock: vi.fn()
}))

vi.mock('./ui-hang-log-sink', () => ({
  recordMainUiHangSample: recordMock,
  getUiHangLifecycleMarkers: getLifecycleMarkersMock,
  clearUiHangLifecycleMarkers: clearLifecycleMarkersMock
}))
vi.mock('./main-thread-churn-probe', () => ({
  drainSubprocessSpawnStats: drainSpawnsMock,
  setSubprocessSpawnAttributionEnabled: setAttributionMock
}))

const { installMainThreadStallProbe, MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS } =
  await import('./main-thread-stall-probe')

function createHarness(enabled = true) {
  const clocks = { monotonic: 0, wall: 0, cpuUser: 0, cpuSystem: 0 }
  const listeners: (() => void)[] = []
  let isEnabled = enabled
  const dispose = installMainThreadStallProbe({
    isEnabled: () => isEnabled,
    subscribe: (listener) => {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
    isVisible: () => true,
    now: () => clocks.monotonic,
    wallNow: () => clocks.wall,
    cpuUsage: () => ({ user: clocks.cpuUser, system: clocks.cpuSystem }),
    tickMs: 500,
    stallThresholdMs: 250
  })
  return {
    clocks,
    dispose,
    setEnabled: (value: boolean) => {
      isEnabled = value
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

beforeEach(() => {
  recordMock.mockClear()
  drainSpawnsMock.mockReset()
  drainSpawnsMock.mockReturnValue({})
  setAttributionMock.mockClear()
  getLifecycleMarkersMock.mockReset()
  getLifecycleMarkersMock.mockReturnValue([])
  clearLifecycleMarkersMock.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installMainThreadStallProbe', () => {
  it('records a main-thread stall while the setting is on', () => {
    const { clocks, dispose } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    vi.advanceTimersByTime(500 + MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)
    expect(recordMock).toHaveBeenCalledWith({
      signal: 'main-stall',
      durationMs: 300,
      surface: 'main',
      visible: true,
      capturedAtMs: 800,
      wallDurationMs: 800,
      intervalStartedAtWallMs: 0,
      intervalEndedAtWallMs: 800,
      lifecycle: [],
      processCpuUserMs: 0,
      processCpuSystemMs: 0
    })
    dispose()
  })

  it('adds CPU time and lifecycle events from the measured interval', () => {
    const marker = { event: 'window-focus', source: 'main', occurredAtWallMs: 750 }
    getLifecycleMarkersMock.mockReturnValue([marker])
    const { clocks, dispose } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    clocks.cpuUser = 150_000
    clocks.cpuSystem = 20_000
    vi.advanceTimersByTime(500 + MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)

    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        wallDurationMs: 800,
        intervalStartedAtWallMs: 0,
        intervalEndedAtWallMs: 800,
        processCpuUserMs: 150,
        processCpuSystemMs: 20,
        lifecycle: [marker]
      })
    )
    dispose()
  })

  it('waits briefly so lifecycle events queued behind the stall can be correlated', () => {
    const { clocks, dispose } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    vi.advanceTimersByTime(500)
    expect(recordMock).not.toHaveBeenCalled()

    const lateMarker = { event: 'window-focus', source: 'main', occurredAtWallMs: 850 }
    getLifecycleMarkersMock.mockReturnValue([lateMarker])
    vi.advanceTimersByTime(MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)

    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: [lateMarker] }))
    expect(getLifecycleMarkersMock).toHaveBeenCalledWith(0, 900)
    dispose()
  })

  it('cancels deferred stall writes when logging is disabled', () => {
    const { clocks, dispose, setEnabled } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    vi.advanceTimersByTime(500)

    setEnabled(false)
    vi.advanceTimersByTime(MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)

    expect(recordMock).not.toHaveBeenCalled()
    dispose()
  })

  it('attributes the stall to the subprocess spawns that blocked the main thread', () => {
    drainSpawnsMock.mockReturnValue({
      'git status': { count: 3, blockMsTotal: 42, blockMsMax: 25 }
    })
    const { clocks, dispose } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    vi.advanceTimersByTime(500 + MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: 'main-stall',
        spawns: { 'git status': { count: 3, blockMsTotal: 42, blockMsMax: 25 } }
      })
    )
    dispose()
  })

  it('omits spawn attribution when the window saw none', () => {
    const { clocks, dispose } = createHarness()
    clocks.monotonic = 800
    clocks.wall = 800
    vi.advanceTimersByTime(500 + MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)
    expect(recordMock.mock.calls[0][0]).not.toHaveProperty('spawns')
    dispose()
  })

  it('gates spawn attribution on the setting', () => {
    const { dispose, setEnabled } = createHarness(false)
    expect(setAttributionMock).not.toHaveBeenCalled()
    setEnabled(true)
    expect(setAttributionMock).toHaveBeenCalledWith(true)
    dispose()
    expect(setAttributionMock).toHaveBeenCalledWith(false)
  })

  it('does not tick while the setting is off', () => {
    const { clocks, dispose } = createHarness(false)
    clocks.monotonic = 5_000
    clocks.wall = 5_000
    vi.advanceTimersByTime(1_000)
    expect(recordMock).not.toHaveBeenCalled()
    dispose()
  })

  it('starts on enable and restarts with a fresh baseline after a disable', () => {
    const { clocks, dispose, setEnabled } = createHarness(false)
    setEnabled(true)
    // A stale baseline would report the whole disabled span as one stall.
    clocks.monotonic = 500
    clocks.wall = 500
    vi.advanceTimersByTime(500)
    expect(recordMock).not.toHaveBeenCalled()

    setEnabled(false)
    clocks.monotonic = 60_000
    clocks.wall = 60_000
    vi.advanceTimersByTime(500)
    setEnabled(true)
    clocks.monotonic = 60_500
    clocks.wall = 60_500
    vi.advanceTimersByTime(500)
    expect(recordMock).not.toHaveBeenCalled()

    clocks.monotonic = 61_300
    clocks.wall = 61_300
    vi.advanceTimersByTime(500 + MAIN_STALL_LIFECYCLE_CORRELATION_GRACE_MS)
    expect(recordMock).toHaveBeenCalledTimes(1)
    dispose()
  })
})
