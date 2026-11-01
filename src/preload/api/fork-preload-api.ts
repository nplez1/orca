import type {
  CopilotCredentialsApi,
  DeepInfraCredentialsApi,
  DeepSeekCredentialsApi,
  FireworksCredentialsApi
} from './agent-account-api'
import { copilotCredentialsApi } from './copilot-credentials-bridge'
import { deepinfraCredentialsApi } from './deepinfra-credentials-bridge'
import { deepseekCredentialsApi } from './deepseek-credentials-bridge'
import { fireworksCredentialsApi } from './fireworks-credentials-bridge'
import type { JenkinsApi } from './jenkins-api'
import { jenkinsApi } from './jenkins-bridge'
import type { SessionSummaryApi } from './session-summary-api'
import { sessionSummaryApi } from './session-summary-bridge'
import { uiHangDiagnosticsApi, type UiHangDiagnosticsApi } from './ui-hang-diagnostics-api'

/**
 * The preload namespaces this fork adds, behind one object.
 *
 * `index.ts` and `api-types.ts` are upstream files edited constantly; a namespace declared here costs
 * them one import and one spread instead of an import plus an entry per feature.
 */
export type ForkPreloadApi = {
  jenkins: JenkinsApi
  uiHangDiagnostics: UiHangDiagnosticsApi
  sessionSummary: SessionSummaryApi
  deepseekCredentials: DeepSeekCredentialsApi
  deepinfraCredentials: DeepInfraCredentialsApi
  fireworksCredentials: FireworksCredentialsApi
  copilotCredentials: CopilotCredentialsApi
}

export const forkPreloadApi: ForkPreloadApi = {
  jenkins: jenkinsApi,
  uiHangDiagnostics: uiHangDiagnosticsApi,
  sessionSummary: sessionSummaryApi,
  deepseekCredentials: deepseekCredentialsApi,
  deepinfraCredentials: deepinfraCredentialsApi,
  fireworksCredentials: fireworksCredentialsApi,
  copilotCredentials: copilotCredentialsApi
}
