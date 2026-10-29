import type { PreloadApi } from '../../../../preload/api-types'
import {
  createCopilotCredentialsApi,
  createDeepSeekCredentialsApi,
  createFireworksCredentialsApi
} from './web-agent-accounts-api'

export type WebForkPreloadApi = Pick<
  PreloadApi,
  'deepseekCredentials' | 'fireworksCredentials' | 'copilotCredentials'
>

/** The web client's stubs for the fork's own preload namespaces, composed in one spread. */
export function createWebForkPreloadApi(): WebForkPreloadApi {
  return {
    deepseekCredentials: createDeepSeekCredentialsApi(),
    fireworksCredentials: createFireworksCredentialsApi(),
    copilotCredentials: createCopilotCredentialsApi()
  }
}
