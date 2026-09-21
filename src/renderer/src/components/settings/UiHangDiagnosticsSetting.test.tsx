// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UiHangDiagnosticsStatus } from '../../../../shared/ui-hang-diagnostics-types'
import { UiHangDiagnosticsSetting } from './UiHangDiagnosticsSetting'

function installApi(status: UiHangDiagnosticsStatus): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane only reaches uiHangDiagnostics.getStatus; the rest of the preload surface never runs.
  window.api = {
    uiHangDiagnostics: {
      getStatus: vi.fn(async () => status),
      record: vi.fn()
    }
  } as never
}

afterEach(() => cleanup())

describe('UiHangDiagnosticsSetting', () => {
  it('toggles the setting from the switch', () => {
    installApi({ enabled: false, logFilePath: '/tmp/logs/ui-hangs.ndjson' })
    const onToggle = vi.fn()
    const { container } = render(<UiHangDiagnosticsSetting enabled={false} onToggle={onToggle} />)

    fireEvent.click(container.querySelector('[role="switch"]')!)

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('shows the log path once enabled', async () => {
    installApi({ enabled: true, logFilePath: '/tmp/logs/ui-hangs.ndjson' })
    const { container } = render(<UiHangDiagnosticsSetting enabled onToggle={vi.fn()} />)

    await waitFor(() => {
      expect(container.textContent).toContain('/tmp/logs/ui-hangs.ndjson')
    })
  })

  it('explains when policy blocks an enabled setting', async () => {
    installApi({
      enabled: false,
      logFilePath: '/tmp/logs/ui-hangs.ndjson',
      disabledReason: 'orca_diagnostics_disabled'
    })
    const { container } = render(<UiHangDiagnosticsSetting enabled onToggle={vi.fn()} />)

    await waitFor(() => {
      expect(container.textContent).toContain('disabled by policy')
    })
  })
})
