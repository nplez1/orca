import { create } from 'zustand'
import {
  getBrowserLanguageDetection,
  setRendererLanguageDetection,
  type UiLanguageDetection
} from '../../../shared/ui-locale'
import { isWebClientLocation } from '../lib/web-client-location'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

export const useLanguageReadiness = create<{
  ready: boolean
  error: boolean
  loading: boolean
  detection: UiLanguageDetection | null
  retryCount: number
  retryLanguageLoad: () => void
}>()((set) => ({
  ready: false,
  error: false,
  loading: false,
  detection: null,
  retryCount: 0,
  retryLanguageLoad: () =>
    set((state) => (state.loading ? state : { loading: true, retryCount: state.retryCount + 1 }))
}))

let detectionPromise: Promise<UiLanguageDetection> | undefined

function publishLanguageDetection(detection: UiLanguageDetection): UiLanguageDetection {
  setRendererLanguageDetection(detection)
  useLanguageReadiness.setState({ detection })
  return detection
}

export function initializeLanguageDetection(): Promise<UiLanguageDetection> {
  const currentDetection = useLanguageReadiness.getState().detection
  if (currentDetection) {
    return Promise.resolve(currentDetection)
  }
  detectionPromise ??= (async () => {
    let detection: UiLanguageDetection | null = null
    const browserClient = isWebClientLocation()
    const browserDetection = getBrowserLanguageDetection(
      browserClient ? 'browser' : 'browser-fallback'
    )
    if (!browserClient) {
      try {
        const snapshot = window.api?.app?.getSystemLanguageDetection?.(
          browserDetection.detectedTag ? [browserDetection.detectedTag] : []
        )
        if (snapshot) {
          detection = await withTimeout<UiLanguageDetection | null>(
            snapshot.then((nativeDetection) =>
              nativeDetection ? publishLanguageDetection(nativeDetection) : null
            ),
            1000,
            null
          )
        }
      } catch {
        // Older local bridges do not provide the optional snapshot.
      }
    }
    detection ??= useLanguageReadiness.getState().detection ?? browserDetection
    return publishLanguageDetection(detection)
  })()
  return detectionPromise
}

// fork-comment-ok: the shared-worker locale reset calls this between files; see that file for why.
/** Drops the cached detection and the readiness state, so the next file detects for itself. */
export function __resetLanguageReadinessForTests(): void {
  detectionPromise = undefined
  useLanguageReadiness.setState(useLanguageReadiness.getInitialState(), true)
}
