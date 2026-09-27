import { ipcRenderer } from 'electron'
import type { JenkinsApi } from './jenkins-api'

export const jenkinsApi: JenkinsApi = {
  listServers: () => ipcRenderer.invoke('jenkins:listServers'),

  saveServer: (args) => ipcRenderer.invoke('jenkins:saveServer', args),

  removeServer: (args: { id: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('jenkins:removeServer', args),

  testServer: (args: { id: string }) => ipcRenderer.invoke('jenkins:testServer', args),

  buildDetails: (args) => ipcRenderer.invoke('jenkins:buildDetails', args)
}
