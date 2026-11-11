import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { pickerExecutionHosts } from '../../../../../shared/execution-host/managed-orcad-execution-host'
import { useSidebarHostScopeOptions } from '../../sidebar/worktree-list/controls/use-sidebar-host-scope-options'
import {
  resolveSettingsHostScope,
  type SettingsHostScope,
  type SettingsHostScopeHost
} from './settings-host-scope'

/** The machines the Settings host picker offers, one row per machine. */
export function useSettingsHosts(): SettingsHostScopeHost[] {
  const { hostOptions } = useSidebarHostScopeOptions()
  return useMemo(() => pickerExecutionHosts(hostOptions), [hostOptions])
}

/** The host Settings is showing. A web client is served by one host and cannot choose another. */
export function useSettingsHostScope(args: {
  choice: ExecutionHostId | null
  isWebClient: boolean
}): { scope: SettingsHostScope; hosts: SettingsHostScopeHost[] } {
  const hosts = useSettingsHosts()
  const settings = useAppStore((state) => state.settings)
  const catalogHydrated = useAppStore((state) => state.runtimeEnvironmentCatalogHydrated)
  // Key by IDs so status-only catalog changes cannot restart host-scoped loads.
  const savedEnvironmentIdsKey = useAppStore((state) =>
    state.runtimeEnvironments.map((environment) => environment.id).join('\n')
  )
  const scope = useMemo(
    () =>
      resolveSettingsHostScope({
        choice: args.isWebClient ? null : args.choice,
        defaultHostId: getSettingsFocusedExecutionHostId(settings),
        hosts,
        savedEnvironmentIds: savedEnvironmentIdsKey ? savedEnvironmentIdsKey.split('\n') : [],
        catalogHydrated
      }),
    [args.choice, args.isWebClient, catalogHydrated, hosts, savedEnvironmentIdsKey, settings]
  )
  return { scope, hosts }
}
