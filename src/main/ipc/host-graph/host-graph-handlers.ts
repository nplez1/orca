import { ipcMain } from 'electron'
import type { HostGraphSnapshot } from '../../../shared/host-graph/host-graph-snapshot'
import { readHostGraph } from '../../host-graph/host-graph-driver'

/**
 * The renderer's read of the fleet.
 *
 * Why a read and nothing else: the driver owns when a refresh happens, so an IPC call can never be
 * the thing that fans out to every paired host.
 */
export function registerHostGraphHandlers(): void {
  ipcMain.handle('hostGraph:read', (): Promise<HostGraphSnapshot> => readHostGraph())
}
