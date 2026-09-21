// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiHangSample } from '../../../../shared/ui-hang-diagnostics-types'
import { startUiHangProbe, UI_HANG_STALL_THRESHOLD_MS, UI_HANG_TICK_MS } from './probe'

type Clocks = { monotonic: number; wall: number }

function startProbe(
  overrides: { visible?: boolean; onSend?: (sample: UiHangSample) => void } = {}
) {
  const clocks: Clocks = { monotonic: 0, wall: 0 }
  const sent: UiHangSample[] = []
  const probe = startUiHangProbe({
    surface: 'main',
    now: () => clocks.monotonic,
    wallNow: () => clocks.wall,
    visible: () => overrides.visible ?? true,
    send: (sample) => {
      sent.push(sample)
      overrides.onSend?.(sample)
    }
  })
  return { clocks, sent, probe }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startUiHangProbe', () => {
  it('records a stall once the tick gap exceeds the threshold', () => {
    vi.useFakeTimers()
    const { clocks, sent, probe } = startProbe()
    clocks.monotonic = UI_HANG_TICK_MS + UI_HANG_STALL_THRESHOLD_MS
    clocks.wall = clocks.monotonic
    vi.advanceTimersByTime(UI_HANG_TICK_MS)
    expect(sent).toEqual([
      {
        signal: 'stall',
        durationMs: UI_HANG_STALL_THRESHOLD_MS,
        surface: 'main',
        visible: true,
        capturedAtMs: UI_HANG_TICK_MS + UI_HANG_STALL_THRESHOLD_MS
      }
    ])
    probe.stop()
  })

  it('stays quiet for a healthy tick', () => {
    vi.useFakeTimers()
    const { clocks, sent, probe } = startProbe()
    clocks.monotonic = UI_HANG_TICK_MS
    clocks.wall = clocks.monotonic
    vi.advanceTimersByTime(UI_HANG_TICK_MS)
    expect(sent).toEqual([])
    probe.stop()
  })

  it('skips a sleep/resume wall-clock jump instead of reporting a fake hang', () => {
    vi.useFakeTimers()
    const { clocks, sent, probe } = startProbe()
    clocks.monotonic = UI_HANG_TICK_MS
    clocks.wall = 60_000
    vi.advanceTimersByTime(UI_HANG_TICK_MS)
    expect(sent).toEqual([])
    probe.stop()
  })

  it('reports the visibility captured at the stall', () => {
    vi.useFakeTimers()
    const { clocks, sent, probe } = startProbe({ visible: false })
    clocks.monotonic = 5_000
    clocks.wall = 5_000
    vi.advanceTimersByTime(UI_HANG_TICK_MS)
    expect(sent[0]?.visible).toBe(false)
    probe.stop()
  })

  it('survives a throwing sink', () => {
    vi.useFakeTimers()
    const { clocks, probe } = startProbe({
      onSend: () => {
        throw new Error('ipc down')
      }
    })
    clocks.monotonic = 5_000
    clocks.wall = 5_000
    expect(() => vi.advanceTimersByTime(UI_HANG_TICK_MS)).not.toThrow()
    probe.stop()
  })
})
