import type { Store } from '../persistence/loading-store/store'
import type { RateLimitService } from '../rate-limits/service'
import { registerCopilotCredentialsHandlers } from './copilot-credentials'
import { registerDeepInfraCredentialsHandlers } from './deepinfra-credentials'
import { registerDeepSeekCredentialsHandlers } from './deepseek-credentials'
import { registerFireworksCredentialsHandlers } from './fireworks-credentials'
import { registerJenkinsHandlers } from './jenkins'
import { registerSessionSummaryHandlers } from './session-summary'
import { registerUiHangDiagnosticsHandlers } from './ui-hang-diagnostics'

/**
 * Every handler group this fork adds to upstream's core registry, behind one call.
 *
 * Upstream owns `register-core-handlers.ts` and edits it constantly; each fork import and call there
 * was another hunk to resolve on every sync. Registration order is not meaningful between these
 * groups — they own disjoint channel names, and `ipcMain.handle` would throw on a duplicate
 * regardless of adjacency.
 */
export function registerForkHandlers({
  store,
  rateLimits
}: {
  store: Pick<Store, 'getSettings'>
  rateLimits: RateLimitService | null
}): void {
  registerJenkinsHandlers()
  registerSessionSummaryHandlers(() => store.getSettings())
  registerUiHangDiagnosticsHandlers(store)
  registerDeepSeekCredentialsHandlers(rateLimits)
  registerDeepInfraCredentialsHandlers(rateLimits)
  registerFireworksCredentialsHandlers(rateLimits)
  registerCopilotCredentialsHandlers(rateLimits)
}
