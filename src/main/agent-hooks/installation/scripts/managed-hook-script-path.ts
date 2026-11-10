import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIRECTORY_NAME } from '../../../../shared/app-directory-names'

// Parallel Orca instances must share one user-wide script path.
export function getSharedManagedScriptPath(scriptFileName: string): string {
  return join(homedir(), HOME_DIRECTORY_NAME, 'agent-hooks', scriptFileName)
}
