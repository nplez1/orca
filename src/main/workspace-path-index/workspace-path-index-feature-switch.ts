export const WORKSPACE_PATH_INDEX_DISABLE_ENV = 'ORCA_DISABLE_WORKSPACE_PATH_INDEX'

/** Mirrors Orca's environment-based safety switches: only an explicit `1` disables it. */
export function isWorkspacePathIndexEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[WORKSPACE_PATH_INDEX_DISABLE_ENV] !== '1'
}

export async function runWorkspacePathIndexIfEnabled<T>(
  operation: () => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env
): Promise<{ enabled: true; value: T } | { enabled: false }> {
  if (!isWorkspacePathIndexEnabled(environment)) {
    return { enabled: false }
  }
  return { enabled: true, value: await operation() }
}
