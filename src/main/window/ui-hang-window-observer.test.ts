import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiHangObservableWindow } from './ui-hang-window-observer'

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }))

vi.mock('../diagnostics/ui-hang-log-sink', () => ({ recordMainUiHangSample: recordMock }))

const { installUiHangWindowObserver } = await import('./ui-hang-window-observer')

function createHarness(enabled = true) {
  const emitter = new EventEmitter()
  const settings: { uiHangDiagnosticsEnabled?: boolean } = { uiHangDiagnosticsEnabled: enabled }
  const window: UiHangObservableWindow = {
    on: emitter.on.bind(emitter),
    isDestroyed: () => false,
    isVisible: () => true
  }
  let clock = 1_000
  installUiHangWindowObserver({
    window,
    store: { getSettings: () => settings },
    surface: 'main',
    now: () => clock
  })
  return { emitter, settings, setClock: (value: number) => (clock = value) }
}

beforeEach(() => {
  recordMock.mockClear()
})

describe('installUiHangWindowObserver', () => {
  it('pairs unresponsive with the recovered duration', () => {
    const { emitter, setClock } = createHarness()
    emitter.emit('unresponsive')
    setClock(32_000)
    emitter.emit('responsive')

    expect(recordMock).toHaveBeenNthCalledWith(1, {
      signal: 'window-unresponsive',
      durationMs: 0,
      surface: 'main',
      visible: true,
      capturedAtMs: 1_000
    })
    expect(recordMock).toHaveBeenNthCalledWith(2, {
      signal: 'window-responsive',
      durationMs: 31_000,
      surface: 'main',
      visible: true,
      capturedAtMs: 32_000
    })
  })

  it('records nothing while the setting is off', () => {
    const { emitter, settings } = createHarness(false)
    emitter.emit('unresponsive')
    emitter.emit('responsive')
    settings.uiHangDiagnosticsEnabled = false
    expect(recordMock).not.toHaveBeenCalled()
  })

  it('picks up a toggle without reinstalling the window', () => {
    const { emitter, settings } = createHarness(false)
    emitter.emit('unresponsive')
    expect(recordMock).not.toHaveBeenCalled()

    settings.uiHangDiagnosticsEnabled = true
    emitter.emit('unresponsive')
    expect(recordMock).toHaveBeenCalledTimes(1)
  })
})
