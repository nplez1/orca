import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const deepinfraCredentialsApi = {
  getStatus: (): Promise<{ configured: boolean; apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepinfraCredentials:getStatus'),
  saveApiKey: (key: string): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepinfraCredentials:saveApiKey', key),
  clearApiKey: (): Promise<{ apiKeyConfigured: boolean }> =>
    ipcRenderer.invoke('deepinfraCredentials:clearApiKey')
} satisfies PreloadApi['deepinfraCredentials']
