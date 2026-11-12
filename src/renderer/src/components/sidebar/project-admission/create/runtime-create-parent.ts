import {
  layoutNestsPrimaryCheckout,
  type WorktreeLayoutMode
} from '../../../../../../shared/orca-workspace-layout'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { getDefaultCreateProjectParent } from './create-project-defaults'
import { getUsableStoredHostRoot } from './clone-defaults'

export const RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS = 3000

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Timed out')), timeoutMs)
    promise.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout)
        }
        resolve(value)
      },
      (error) => {
        if (timeout) {
          clearTimeout(timeout)
        }
        reject(error)
      }
    )
  })
}

/** A stored root wins; otherwise the host's own home names the container for the layout in use. */
export function resolveRuntimeCreateParent(args: {
  runtimeEnvironmentId: string
  worktreeLayoutMode?: WorktreeLayoutMode
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
}): Promise<{ parent: string }> {
  const hostIds = [toRuntimeExecutionHostId(args.runtimeEnvironmentId)]
  const layoutMode = args.worktreeLayoutMode ?? 'repo-nested'
  const overrides = { hostSettingOverrides: args.hostSettingOverrides }
  const stored =
    getUsableStoredHostRoot(overrides, hostIds, 'defaultRepoRoot') ??
    (layoutNestsPrimaryCheckout(layoutMode)
      ? (getUsableStoredHostRoot(overrides, hostIds, 'defaultWorktreeLocation') ?? '')
      : '')
  if (stored) {
    return Promise.resolve({ parent: stored })
  }
  return withTimeout(
    browseRuntimeServerDirectory(args.runtimeEnvironmentId, '~'),
    RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS
  ).then((result) => ({
    parent: getDefaultCreateProjectParent(result.resolvedPath, args.worktreeLayoutMode)
  }))
}
