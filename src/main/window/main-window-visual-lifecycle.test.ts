import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordMainUiHangSampleMock } = vi.hoisted(() => ({
  recordMainUiHangSampleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../diagnostics/ui-hang-log-sink', () => ({
  recordMainUiHangSample: recordMainUiHangSampleMock
}))

import { invalidateMainWindowOnFocus } from './main-window-visual-lifecycle'

describe('invalidateMainWindowOnFocus', () => {
  beforeEach(() => {
    recordMainUiHangSampleMock.mockClear()
  })

  it('records invalidation duration when UI-hang logging is enabled', () => {
    const invalidate = vi.fn()
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { isDestroyed: () => false, invalidate }
    }
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(18)

    invalidateMainWindowOnFocus(window, true)

    expect(invalidate).toHaveBeenCalledOnce()
    expect(recordMainUiHangSampleMock).toHaveBeenCalledWith({
      signal: 'handler',
      operation: 'window-focus-invalidate',
      durationMs: 8,
      surface: 'main',
      visible: true,
      capturedAtMs: 18
    })
  })

  it('does not measure or log while UI-hang logging is disabled', () => {
    const invalidate = vi.fn()
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      webContents: { isDestroyed: () => false, invalidate }
    }
    invalidateMainWindowOnFocus(window, false)

    expect(invalidate).toHaveBeenCalledOnce()
    expect(recordMainUiHangSampleMock).not.toHaveBeenCalled()
  })

  it('skips invalidation after the window or web contents are destroyed', () => {
    const invalidate = vi.fn()
    const window = {
      isDestroyed: () => true,
      isVisible: () => false,
      webContents: { isDestroyed: () => false, invalidate }
    }

    invalidateMainWindowOnFocus(window, true)

    expect(invalidate).not.toHaveBeenCalled()
    expect(recordMainUiHangSampleMock).not.toHaveBeenCalled()
  })
})
