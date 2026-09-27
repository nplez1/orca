import type { UiHangLifecycleEvent } from '../../shared/ui-hang-diagnostics-types'
import { recordUiHangLifecycleMarker } from './ui-hang-log-sink'

type LifecycleEventSource = {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

export type UiHangLifecycleObserverOptions = {
  app: LifecycleEventSource
  powerMonitor: LifecycleEventSource
  isEnabled: () => boolean
}

/** Records allowlisted process lifecycle markers only while UI-hang logging is enabled. */
export function installUiHangLifecycleObserver(
  options: UiHangLifecycleObserverOptions
): () => void {
  const subscribe = (
    source: LifecycleEventSource,
    eventName: string,
    marker: UiHangLifecycleEvent
  ): (() => void) => {
    const listener = (): void => {
      if (options.isEnabled()) {
        recordUiHangLifecycleMarker(marker, 'main')
      }
    }
    source.on(eventName, listener)
    return () => source.off(eventName, listener)
  }
  const unsubscribe = [
    subscribe(options.app, 'browser-window-focus', 'app-focus'),
    subscribe(options.powerMonitor, 'suspend', 'system-suspend'),
    subscribe(options.powerMonitor, 'resume', 'system-resume')
  ]
  return () => {
    for (const remove of unsubscribe) {
      remove()
    }
  }
}
