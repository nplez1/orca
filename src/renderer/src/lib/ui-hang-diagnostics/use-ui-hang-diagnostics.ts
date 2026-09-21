import { useEffect } from 'react'
import type { UiHangSurface } from '../../../../shared/ui-hang-diagnostics-types'
import { useAppStore } from '../../store'
import { startUiHangProbe } from './probe'

/**
 * Runs the UI-hang stall probe while `uiHangDiagnosticsEnabled` is on. Lives at the app root
 * (and the pop-out root) so it keeps measuring while the user works, not only while Settings
 * happens to be open.
 */
export function useUiHangDiagnostics(surface: UiHangSurface = 'main'): void {
  const enabled = useAppStore((state) => state.settings?.uiHangDiagnosticsEnabled === true)

  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    const api = window.api.uiHangDiagnostics
    const probe = startUiHangProbe({
      surface,
      send: (sample) => api.record(sample)
    })
    return () => probe.stop()
  }, [enabled, surface])
}
