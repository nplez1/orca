import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const copilotCredentialsApi = {
  getStatus: (): Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }> => ipcRenderer.invoke('copilotCredentials:getStatus'),
  save: (
    token: string,
    enterpriseSlug: string
  ): Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }> => ipcRenderer.invoke('copilotCredentials:save', token, enterpriseSlug),
  clear: (): Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }> => ipcRenderer.invoke('copilotCredentials:clear')
} satisfies PreloadApi['copilotCredentials']
