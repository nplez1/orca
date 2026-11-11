import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { MergedExecutionHost } from '../../../../../shared/execution-host/managed-orcad-execution-host'
import { indexExecutionHostsById } from '../../../../../shared/execution-host/managed-orcad-execution-host'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

/** The host rows the Settings picker shows; labels already carry renames. */
export type SettingsHostScopeHost = MergedExecutionHost & { label: string }

export type SettingsHostScope = {
  /** The row the picker shows: for a merged machine, the id that currently stands for it. */
  hostId: ExecutionHostId
  label: string
  /** Every id this machine answers to, so one folder is read and written under a merged pair. */
  equivalentHostIds: readonly ExecutionHostId[]
  /** null when this machine has no server endpoint; never a silent `local` fallback. */
  target: RuntimeClientTarget | null
  available: boolean
}

/** A scope whose panes can talk to a server, local or paired. */
export type SettingsServerScope = SettingsHostScope & { target: RuntimeClientTarget }

export function isServerScope(scope: SettingsHostScope): scope is SettingsServerScope {
  return scope.target !== null
}

export const LOCAL_SETTINGS_HOST_SCOPE: SettingsServerScope = {
  hostId: LOCAL_EXECUTION_HOST_ID,
  label: getLocalExecutionHostLabel(),
  equivalentHostIds: [LOCAL_EXECUTION_HOST_ID],
  target: { kind: 'local' },
  available: true
}

function scopeForHostId(args: {
  hostId: ExecutionHostId
  label: string
  equivalentHostIds: readonly ExecutionHostId[]
  savedEnvironmentIds: readonly string[]
  catalogHydrated: boolean
}): SettingsHostScope {
  const { hostId, label, equivalentHostIds } = args
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return { hostId, label, equivalentHostIds, target: null, available: false }
  }
  if (parsed.kind === 'runtime') {
    return {
      hostId,
      label,
      equivalentHostIds,
      target: { kind: 'environment', environmentId: parsed.environmentId },
      // An unhydrated catalog does not prove the server was removed.
      available: !args.catalogHydrated || args.savedEnvironmentIds.includes(parsed.environmentId)
    }
  }
  if (parsed.kind === 'ssh') {
    // A merged pair stands for the server it deploys; an unmerged SSH row is machine-only.
    const server = equivalentHostIds
      .map((id) => parseExecutionHostId(id))
      .find((candidate) => candidate?.kind === 'runtime')
    const environmentId = server?.kind === 'runtime' ? server.environmentId : null
    return {
      hostId,
      label,
      equivalentHostIds,
      target: environmentId ? { kind: 'environment', environmentId } : null,
      available: true
    }
  }
  return { hostId, label, equivalentHostIds, target: { kind: 'local' }, available: true }
}

export function resolveSettingsHostScope(args: {
  choice: ExecutionHostId | null
  /** Seeds the initial choice; never overrides an explicit selection. */
  defaultHostId: ExecutionHostId | null | undefined
  hosts: readonly SettingsHostScopeHost[]
  savedEnvironmentIds: readonly string[]
  catalogHydrated: boolean
}): SettingsHostScope {
  const requestedHostId = args.choice ?? (args.defaultHostId || LOCAL_EXECUTION_HOST_ID)
  // A merged-away id resolves to the row that stands for it, so the picker always shows a row.
  const shown = indexExecutionHostsById(args.hosts).get(requestedHostId)
  return scopeForHostId({
    hostId: shown?.id ?? requestedHostId,
    label: shown?.label ?? fallbackHostLabel(requestedHostId),
    equivalentHostIds: shown ? [shown.id, ...(shown.aliasHostIds ?? [])] : [requestedHostId],
    savedEnvironmentIds: args.savedEnvironmentIds,
    catalogHydrated: args.catalogHydrated
  })
}

/** A host the registry does not list yet: name it by what it is, never as this computer. */
function fallbackHostLabel(hostId: ExecutionHostId): string {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed || parsed.kind === 'local') {
    return getLocalExecutionHostLabel()
  }
  return parsed.kind === 'ssh' ? parsed.targetId : parsed.environmentId
}

/** The picker value a Settings navigation target names. */
export function settingsNavigationHostId(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'environment'
    ? toRuntimeExecutionHostId(target.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}
