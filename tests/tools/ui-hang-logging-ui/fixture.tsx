// Rendered production `AdvancedPane` in a hidden Electron window, for the UI-hang logging
// visual proof. Same shape as tests/tools/omp-source-control-ui/fixture.tsx.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { getDefaultSettings } from '../../../src/shared/constants'
import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import { AdvancedPane } from '../../../src/renderer/src/components/settings/AdvancedPane'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import { useAppStore } from '../../../src/renderer/src/store'
import './fixture.css'

// A plausible path so the screenshot shows what a user would actually copy.
const LOG_PATH = '/Users/you/Library/Application Support/Orca/logs/ui-hangs.ndjson'

const settings = getDefaultSettings('/disposable-ui-hang-home')
const updateSettings = (patch: Partial<GlobalSettings>): void => {
  const current = useAppStore.getState().settings
  if (!current) {
    throw new Error('Settings fixture not initialized')
  }
  useAppStore.setState({ settings: { ...current, ...patch } })
}
useAppStore.setState({ settings, repos: [], settingsSearchQuery: '', updateSettings })

// Why Object.assign and not `window.api = ... as never`: this file is linted by the
// changed-code quality gate, which rejects new type assertions.
Object.assign(window, {
  api: {
    uiHangDiagnostics: {
      record: (): void => {},
      getStatus: async (): Promise<{ enabled: boolean; logFilePath: string }> => ({
        enabled: useAppStore.getState().settings?.uiHangDiagnosticsEnabled === true,
        logFilePath: LOG_PATH
      })
    }
  }
})

function Fixture(): React.JSX.Element {
  const current = useAppStore((state) => state.settings)
  if (!current) {
    throw new Error('Missing fixture settings')
  }
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-3xl p-6">
        <AdvancedPane settings={current} updateSettings={updateSettings} />
      </main>
    </TooltipProvider>
  )
}

const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing fixture root')
}
createRoot(root).render(<Fixture />)
