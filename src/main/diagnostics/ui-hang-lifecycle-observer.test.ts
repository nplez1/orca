import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordMarkerMock } = vi.hoisted(() => ({ recordMarkerMock: vi.fn() }))

vi.mock('./ui-hang-log-sink', () => ({ recordUiHangLifecycleMarker: recordMarkerMock }))

import { installUiHangLifecycleObserver } from './ui-hang-lifecycle-observer'

describe('installUiHangLifecycleObserver', () => {
  beforeEach(() => recordMarkerMock.mockClear())

  it('records app focus and system power transitions only while enabled', () => {
    const app = new EventEmitter()
    const powerMonitor = new EventEmitter()
    let enabled = false
    const uninstall = installUiHangLifecycleObserver({
      app,
      powerMonitor,
      isEnabled: () => enabled
    })

    app.emit('browser-window-focus')
    powerMonitor.emit('suspend')
    enabled = true
    app.emit('browser-window-focus')
    powerMonitor.emit('suspend')
    powerMonitor.emit('resume')

    expect(recordMarkerMock.mock.calls.map((call) => call[0])).toEqual([
      'app-focus',
      'system-suspend',
      'system-resume'
    ])
    uninstall()
  })

  it('removes every process listener on dispose', () => {
    const app = new EventEmitter()
    const powerMonitor = new EventEmitter()
    const uninstall = installUiHangLifecycleObserver({ app, powerMonitor, isEnabled: () => true })

    uninstall()
    app.emit('browser-window-focus')
    powerMonitor.emit('suspend')
    powerMonitor.emit('resume')

    expect(recordMarkerMock).not.toHaveBeenCalled()
  })
})
