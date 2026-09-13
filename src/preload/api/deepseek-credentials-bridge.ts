import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const deepseekCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean; apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepseekCredentials:getStatus'),
  saveApiKey: (key: string): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepseekCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepseekCredentials:clearApiKey')
} satisfies PreloadApi['deepseekCredentials']
