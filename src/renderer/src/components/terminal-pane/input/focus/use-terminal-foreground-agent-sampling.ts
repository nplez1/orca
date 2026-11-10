import { useEffect } from 'react'
import type { IDisposable } from '@xterm/xterm'
import type { UseTerminalPaneLifecycleDeps } from '../../mounting/terminal-pane-lifecycle-types'
import { recordUiHangOperation } from '@/lib/ui-hang-diagnostics/record-ui-hang-operation'

type SampleableBinding = IDisposable & { sampleForegroundAgentOnFocus?: () => void }

/** Why module-level: a try/finally in the hook body bails React Compiler out of the whole hook. */
function sampleForegroundAgent(binding: SampleableBinding | undefined): void {
  const startedAtMs = performance.now()
  try {
    binding?.sampleForegroundAgentOnFocus?.()
  } finally {
    recordUiHangOperation('foreground-agent-focus-sample', startedAtMs)
  }
}

export function useTerminalForegroundAgentSampling(
  deps: Pick<
    UseTerminalPaneLifecycleDeps,
    'isActive' | 'isVisible' | 'managerRef' | 'panePtyBindingsRef'
  >
): void {
  useEffect(() => {
    if (!deps.isActive || !deps.isVisible || typeof window === 'undefined') {
      return
    }
    const onWindowFocus = (): void => {
      const activePane = deps.managerRef.current?.getActivePane()
      if (!activePane) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Sampling is optional on the disposable binding and guarded before invocation.
      const binding = deps.panePtyBindingsRef.current.get(activePane.id) as
        | SampleableBinding
        | undefined
      sampleForegroundAgent(binding)
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [deps.isActive, deps.isVisible, deps.managerRef, deps.panePtyBindingsRef])
}
