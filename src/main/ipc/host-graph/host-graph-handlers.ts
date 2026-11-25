import { ipcMain } from 'electron'
import type { HostGraphSnapshot } from '../../../shared/host-graph/host-graph-snapshot'
import { readHostGraph } from '../../host-graph/host-graph-driver'

/**
 * The renderer's read of the fleet.
 *
 * Why the renderer cannot ask for a refresh: the driver decides when the fleet is old enough to re-ask,
 * so a renderer that renders often cannot turn into a fan-out per render.
 */
export function registerHostGraphHandlers(): void {
  ipcMain.handle('hostGraph:read', (): Promise<HostGraphSnapshot> => readHostGraph())
}
