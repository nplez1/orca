// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({ getStateMock: vi.fn() }))

vi.mock('../../store', () => ({ useAppStore: { getState: getStateMock } }))

import { recordUiHangLifecycleEvent, recordUiHangOperation } from './record-ui-hang-operation'

describe('recordUiHangOperation', () => {
  const record = vi.fn()
  let previousApi: PropertyDescriptor | undefined
  let previousVisibilityState: PropertyDescriptor | undefined

  beforeEach(() => {
    getStateMock.mockReset()
    vi.spyOn(performance, 'now').mockReturnValue(90)
    previousApi = Object.getOwnPropertyDescriptor(window, 'api')
    previousVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { uiHangDiagnostics: { record } }
    })
  })

  afterEach(() => {
    record.mockReset()
    vi.restoreAllMocks()
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
    if (previousVisibilityState) {
      Object.defineProperty(document, 'visibilityState', previousVisibilityState)
    } else {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('records allowlisted lifecycle transitions only while enabled', () => {
    getStateMock.mockReturnValue({ settings: { uiHangDiagnosticsEnabled: true } })

    recordUiHangLifecycleEvent('document-hidden')

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: 'lifecycle',
        lifecycleEvent: 'document-hidden',
        durationMs: 0,
        surface: 'main',
        visible: true,
        capturedAtMs: 90,
        capturedAtWallMs: expect.any(Number)
      })
    )
  })

  it('records bounded operation timing when logging is enabled', () => {
    getStateMock.mockReturnValue({ settings: { uiHangDiagnosticsEnabled: true } })

    recordUiHangOperation('terminal-focus-recovery', 12)

    expect(record).toHaveBeenCalledWith({
      signal: 'handler',
      operation: 'terminal-focus-recovery',
      durationMs: 78,
      surface: 'main',
      visible: true,
      capturedAtMs: 90,
      capturedAtWallMs: expect.any(Number)
    })
  })

  it('limits repeated operation records to one per second', () => {
    getStateMock.mockReturnValue({ settings: { uiHangDiagnosticsEnabled: true } })
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_500)
      .mockReturnValueOnce(2_000)

    recordUiHangOperation('terminal-system-resume-recovery', 900)
    recordUiHangOperation('terminal-system-resume-recovery', 1_400)
    recordUiHangOperation('terminal-system-resume-recovery', 1_900)

    expect(record).toHaveBeenCalledTimes(2)
  })

  it('does not send IPC when logging is disabled', () => {
    getStateMock.mockReturnValue({ settings: { uiHangDiagnosticsEnabled: false } })

    recordUiHangOperation('terminal-focus-recovery', 12)

    expect(record).not.toHaveBeenCalled()
  })
})
