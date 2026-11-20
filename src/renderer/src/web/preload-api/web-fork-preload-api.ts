import type { PreloadApi } from '../../../../preload/api-types'
import {
  createCopilotCredentialsApi,
  createDeepInfraCredentialsApi,
  createDeepSeekCredentialsApi,
  createFireworksCredentialsApi
} from './agents/web-agent-accounts-api'
import { createWebSessionSummaryApi } from './web-session-summary-api'

export type WebForkPreloadApi = Pick<
  PreloadApi,
  | 'deepseekCredentials'
  | 'deepinfraCredentials'
  | 'fireworksCredentials'
  | 'copilotCredentials'
  | 'sessionSummary'
>

/** The web client's stubs for the fork's own preload namespaces, composed in one spread. */
export function createWebForkPreloadApi(): WebForkPreloadApi {
  return {
    deepseekCredentials: createDeepSeekCredentialsApi(),
    deepinfraCredentials: createDeepInfraCredentialsApi(),
    fireworksCredentials: createFireworksCredentialsApi(),
    copilotCredentials: createCopilotCredentialsApi(),
    sessionSummary: createWebSessionSummaryApi()
  }
}
