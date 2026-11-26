import { ipcRenderer } from 'electron'
import type { HostGraphSnapshot } from '../../shared/host-graph/host-graph-snapshot'
import type { HostGraphApi } from './host-graph-api'

export const hostGraphApi = {
  read: (): Promise<HostGraphSnapshot> => ipcRenderer.invoke('hostGraph:read')
} satisfies HostGraphApi
