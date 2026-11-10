import { shallow } from 'zustand/shallow'
import { persistedUIValuesEqual } from '../../../../../../shared/persisted-ui-equality'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { selectWslHostsServing } from '../../use-wsl-hosts-enabled'
import { selectEphemeralVmHostLifecycles } from '@/store/slices/ephemeral-vm/ephemeral-vm-lifecycle'
import {
  type SidebarHostOption,
  buildSidebarHostOptions,
  sidebarHostSemantics
} from '../controls/sidebar-host-options'

export function createSidebarHostOptionsSelector() {
  let inputs: readonly unknown[] = []
  let result: SidebarHostOption[] = []
  return (
    state: AppState,
    repos: readonly Repo[],
    settings: AppState['settings'],
    hostLabelOverrides: Parameters<typeof buildSidebarHostOptions>[0]['hostLabelOverrides']
  ): SidebarHostOption[] => {
    const nextInputs = [
      repos,
      state.sshTargetLabels,
      state.sshConnectionStates,
      settings,
      state.runtimeStatusByEnvironmentId,
      state.runtimeEnvironments,
      hostLabelOverrides,
      state.wslHostStatuses,
      selectWslHostsServing(state),
      state.wslHostServerFiles === 'missing',
      selectEphemeralVmHostLifecycles(state)
    ]
    if (shallow(inputs, nextInputs)) {
      return result
    }
    inputs = nextInputs
    const next = buildSidebarHostOptions({
      repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides,
      wslHostStatuses: state.wslHostStatuses,
      wslHostsEnabled: selectWslHostsServing(state),
      wslHostServerFilesMissing: state.wslHostServerFiles === 'missing',
      ephemeralVmHosts: selectEphemeralVmHostLifecycles(state)
    })
    if (!persistedUIValuesEqual(result.map(sidebarHostSemantics), next.map(sidebarHostSemantics))) {
      result = next
    }
    return result
  }
}
