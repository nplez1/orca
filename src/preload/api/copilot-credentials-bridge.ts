import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const copilotCredentialsApi = {
  getStatus: (): Promise<{
    configured: boolean
    ghStatus: 'ok' | 'gh-missing' | 'unauthenticated' | 'missing-scope'
    ghSetupHint: string | null
  }> => ipcRenderer.invoke('copilotCredentials:getStatus')
} satisfies PreloadApi['copilotCredentials']
