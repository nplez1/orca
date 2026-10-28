import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isPlainObject, readHooksJson, writeHooksJson } from '../agent-hooks/installer-utils'

// Qoder 1.1.64 writes this exact shape after accepting its folder-trust prompt.
export function withQoderTrustedWorkspace(
  config: Record<string, unknown>,
  workspacePath: string
): Record<string, unknown> | null {
  if (config.permissions !== undefined && !isPlainObject(config.permissions)) {
    return null
  }
  const permissions = isPlainObject(config.permissions) ? config.permissions : {}
  if (permissions.trustDirectories !== undefined && !Array.isArray(permissions.trustDirectories)) {
    return null
  }
  const existing = Array.isArray(permissions.trustDirectories) ? permissions.trustDirectories : []
  if (existing.includes(workspacePath)) {
    return config
  }
  return {
    ...config,
    permissions: { ...permissions, trustDirectories: [...existing, workspacePath] }
  }
}

export async function markQoderWorkspaceTrusted(
  workspacePath: string,
  home: string,
  configDirName: '.qoder' | '.qoder-cn' = '.qoder'
): Promise<void> {
  let canonicalPath = workspacePath
  try {
    // Why async: realpath probes the workspace's volume, and a stalled one would freeze the app.
    canonicalPath = await realpath(workspacePath)
  } catch {
    // Missing paths retain their supplied spelling.
  }
  const configPath = join(home, configDirName, 'settings.json')
  const config = readHooksJson(configPath)
  if (!config) {
    return
  }
  const updated = withQoderTrustedWorkspace(config, canonicalPath)
  if (updated && updated !== config) {
    writeHooksJson(configPath, updated)
  }
}
