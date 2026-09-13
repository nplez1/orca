import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const fireworksCredentialsApi = {
  getStatus: (): Promise<{
    configured: boolean
    apiKeyConfigured: boolean
    accountIdOverride: string | null
  }> => ipcRenderer.invoke('fireworksCredentials:getStatus'),
  save: (
    apiKey: string,
    accountIdOverride: string | null
  ): Promise<{ apiKeyConfigured: boolean; accountIdOverride: string | null }> =>
    ipcRenderer.invoke('fireworksCredentials:save', apiKey, accountIdOverride),
  clear: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('fireworksCredentials:clear')
} satisfies PreloadApi['fireworksCredentials']
