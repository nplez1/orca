import type { ExecutionHostId } from './execution-host'
import type { GlobalSettings } from './global-settings-types'

/** Limit per-host preferences to host-specific values: client-side display labels and filesystem roots.
 * Remote hosts cannot reuse a local workspaceDir unchanged. */
export type HostSettingOverrides = {
  displayLabel?: string
  /** Where this host's worktrees live. */
  defaultWorktreeLocation?: string
  /** Where this host's checkouts live; equal to the worktree root only under a nested layout. */
  defaultRepoRoot?: string
}

// Share host override ?? client default across UI/registry/tests.

export type HostSettingOverrideKey = keyof HostSettingOverrides

type HostSettingsSlice = Pick<GlobalSettings, 'hostSettingOverrides'>

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** Returns the host's override for `key` if present and non-empty, else `undefined`. */
export function getHostSettingOverride(
  settings: HostSettingsSlice | null | undefined,
  hostId: ExecutionHostId,
  key: HostSettingOverrideKey
): string | undefined {
  return normalize(settings?.hostSettingOverrides?.[hostId]?.[key])
}

/** The first non-empty override among a machine's ids, so a merged row reads the same value under either id. */
export function getHostSettingOverrideForIds(
  settings: HostSettingsSlice | null | undefined,
  hostIds: readonly ExecutionHostId[],
  key: HostSettingOverrideKey
): string | undefined {
  for (const hostId of hostIds) {
    const value = getHostSettingOverride(settings, hostId, key)
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

/** Writes the first id and clears the rest, so a stale alias override cannot shadow the new value. */
export function setHostSettingOverrideForIds(
  settings: HostSettingsSlice | null | undefined,
  hostIds: readonly ExecutionHostId[],
  key: HostSettingOverrideKey,
  value: string
): Partial<Record<ExecutionHostId, HostSettingOverrides>> {
  const [primary, ...aliases] = hostIds
  if (!primary) {
    return settings?.hostSettingOverrides ?? {}
  }
  return aliases.reduce(
    (next, hostId) => clearHostSettingOverride({ hostSettingOverrides: next }, hostId, key),
    setHostSettingOverride(settings, primary, key, value)
  )
}

/** Clears every id a merged machine answers to, so Reset cannot leave the value under an alias. */
export function clearHostSettingOverrideForIds(
  settings: HostSettingsSlice | null | undefined,
  hostIds: readonly ExecutionHostId[],
  key: HostSettingOverrideKey
): Partial<Record<ExecutionHostId, HostSettingOverrides>> {
  return hostIds.reduce(
    (next, hostId) => clearHostSettingOverride({ hostSettingOverrides: next }, hostId, key),
    settings?.hostSettingOverrides ?? {}
  )
}

/** `host override ?? client default`. Unknown hosts and cleared overrides fall back. */
export function getEffectiveHostSetting(
  settings: HostSettingsSlice | null | undefined,
  hostId: ExecutionHostId,
  key: HostSettingOverrideKey,
  clientDefault: string
): string {
  return getHostSettingOverride(settings, hostId, key) ?? clientDefault
}

/** Return the updated override map; empty/whitespace clears instead of persisting blanks. */
export function setHostSettingOverride(
  settings: HostSettingsSlice | null | undefined,
  hostId: ExecutionHostId,
  key: HostSettingOverrideKey,
  value: string
): Partial<Record<ExecutionHostId, HostSettingOverrides>> {
  const normalized = normalize(value)
  if (normalized === undefined) {
    return clearHostSettingOverride(settings, hostId, key)
  }
  const current = settings?.hostSettingOverrides ?? {}
  return {
    ...current,
    [hostId]: { ...current[hostId], [key]: normalized }
  }
}

/** Remove a key and drop host entries with no remaining overrides. */
export function clearHostSettingOverride(
  settings: HostSettingsSlice | null | undefined,
  hostId: ExecutionHostId,
  key: HostSettingOverrideKey
): Partial<Record<ExecutionHostId, HostSettingOverrides>> {
  const current = settings?.hostSettingOverrides
  const hostOverrides = current?.[hostId]
  if (!current || !hostOverrides || !(key in hostOverrides)) {
    return current ?? {}
  }
  const { [key]: _removed, ...remaining } = hostOverrides
  const next = { ...current }
  if (Object.keys(remaining).length === 0) {
    delete next[hostId]
  } else {
    next[hostId] = remaining
  }
  return next
}

/** Builds the `displayLabel` lookup map the host registry consumes. */
export function getHostDisplayLabelOverrides(
  settings: HostSettingsSlice | null | undefined
): ReadonlyMap<ExecutionHostId, string> {
  const result = new Map<ExecutionHostId, string>()
  for (const [hostId, overrides] of Object.entries(settings?.hostSettingOverrides ?? {})) {
    const label = normalize(overrides?.displayLabel)
    if (label) {
      result.set(hostId as ExecutionHostId, label)
    }
  }
  return result
}
