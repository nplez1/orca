import type { WorktreeLayoutMode } from '../../../../../../shared/orca-workspace-layout'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { canonicalHostIdOrder } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { resolveCheckoutParent } from '../../../../../../shared/host-repo-root'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
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

/** A stored root wins; otherwise the host's own home names the folder the layout puts checkouts in. */
export function resolveRuntimeCreateParent(args: {
  runtimeEnvironmentId: string
  worktreeLayoutMode?: WorktreeLayoutMode
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
  /** Every id the machine answers to, so a folder stored under a merged alias is found. */
  overrideHostIds?: readonly ExecutionHostId[]
}): Promise<{ parent: string }> {
  const hostIds = canonicalHostIdOrder([
    toRuntimeExecutionHostId(args.runtimeEnvironmentId),
    ...(args.overrideHostIds ?? [])
  ])
  const layoutMode = args.worktreeLayoutMode ?? 'repo-nested'
  const overrides = { hostSettingOverrides: args.hostSettingOverrides }
  const stored = resolveCheckoutParent({
    storedRepoRoot: getUsableStoredHostRoot(overrides, hostIds, 'defaultRepoRoot'),
    storedWorktreeRoot: getUsableStoredHostRoot(overrides, hostIds, 'defaultWorktreeLocation'),
    layoutMode
  })
  if (stored) {
    return Promise.resolve({ parent: stored })
  }
  return withTimeout(
    browseRuntimeServerDirectory(args.runtimeEnvironmentId, '~'),
    RUNTIME_GIT_AVAILABILITY_TIMEOUT_MS
  ).then((result) => ({
    parent: resolveCheckoutParent({ layoutMode, hostHome: result.resolvedPath })
  }))
}
