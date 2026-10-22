import { useMemo } from 'react'
import {
  buildExecutionHostRegistry,
  type ExecutionHostRegistryEntry
} from '../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { useAppStore } from '@/store'

/**
 * The `configured-only` host registry behind every "where can this project go" surface.
 * One hook so the sidebar's Add to… menu and Settings → Available Hosts can never offer
 * different destination lists.
 */
export function useConfiguredExecutionHostOptions(): ExecutionHostRegistryEntry[] {
  const repos = useAppStore((state) => state.repos)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])

  return useMemo(
    () =>
      buildExecutionHostRegistry({
        repos,
        settings,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      }),
    [
      repos,
      settings,
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
}
