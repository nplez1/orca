import { ipcMain } from 'electron'
import type { HostMeshSettings } from '../../../shared/host-mesh/host-mesh-admission'
import { HOST_MESH_MAX_LABEL_CHARS } from '../../../shared/host-mesh/host-mesh-contract'
import {
  joinHostMesh,
  leaveHostMeshGroup,
  readHostMeshSnapshot,
  removeHostMeshMember,
  renameHostMeshMember,
  updateHostMeshSettings
} from '../../host-mesh/host-mesh-runtime'

const SETTING_KEYS = ['enabled'] as const

/**
 * The renderer's whole access to the mesh.
 *
 * Why every mutation answers with a snapshot: each one moves several members at once, so a surface that
 * read again afterwards could render a state its own action did not produce.
 */
export function registerHostMeshHandlers(): void {
  ipcMain.handle('hostMesh:read', () => readHostMeshSnapshot())
  ipcMain.handle('hostMesh:join', (_event, environmentId: unknown) =>
    joinHostMesh(readId(environmentId))
  )
  ipcMain.handle('hostMesh:remove', (_event, hostKey: unknown) =>
    removeHostMeshMember(readId(hostKey))
  )
  // Why the length is bounded here as well as in the driver: the store this name lands in is capped, and a
  // renderer bug should not be the thing that finds out.
  ipcMain.handle('hostMesh:rename', (_event, hostKey: unknown, label: unknown) =>
    renameHostMeshMember(readId(hostKey), readLabel(label))
  )
  ipcMain.handle('hostMesh:leave', () => leaveHostMeshGroup())
  ipcMain.handle('hostMesh:settings', (_event, patch: unknown) =>
    updateHostMeshSettings(readSettingsPatch(patch))
  )
}

/** Why guarded: the argument crosses the process boundary, where its type is erased. */
function readId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('host_mesh_invalid_request')
  }
  return value
}

/** A name is the only free text the mesh stores, so it is trimmed and bounded before it reaches the driver. */
function readLabel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('host_mesh_invalid_request')
  }
  const label = value.trim()
  if (label === '' || label.length > HOST_MESH_MAX_LABEL_CHARS) {
    throw new Error('host_mesh_invalid_request')
  }
  return label
}

/** Why a guard and not a cast: the patch crossed the process boundary, where its shape is unproven. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Why narrowed to the known keys: the patch is persisted, so a stray key would travel into the file. */
function readSettingsPatch(value: unknown): Partial<HostMeshSettings> {
  const patch: Partial<HostMeshSettings> = {}
  if (!isUnknownRecord(value)) {
    return patch
  }
  for (const key of SETTING_KEYS) {
    const next = value[key]
    if (typeof next === 'boolean') {
      patch[key] = next
    }
  }
  return patch
}
