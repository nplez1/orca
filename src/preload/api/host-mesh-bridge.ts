import { ipcRenderer } from 'electron'
import type { HostMeshSettings } from '../../shared/host-mesh/host-mesh-admission'
import type { HostMeshApi, HostMeshJoinOutcome, HostMeshSnapshot } from './host-mesh-api'

export const hostMeshApi = {
  read: (): Promise<HostMeshSnapshot> => ipcRenderer.invoke('hostMesh:read'),
  join: (environmentId: string): Promise<HostMeshJoinOutcome> =>
    ipcRenderer.invoke('hostMesh:join', environmentId),
  remove: (hostKey: string): Promise<HostMeshSnapshot> =>
    ipcRenderer.invoke('hostMesh:remove', hostKey),
  leave: (): Promise<HostMeshSnapshot> => ipcRenderer.invoke('hostMesh:leave'),
  settings: (patch: Partial<HostMeshSettings>): Promise<HostMeshSnapshot> =>
    ipcRenderer.invoke('hostMesh:settings', patch)
} satisfies HostMeshApi
