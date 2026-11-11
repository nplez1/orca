import { useCallback, useState } from 'react'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { settingsNavigationHostId } from './settings-host-scope'

/** A chat-scoped account view lasts only for this Settings visit. */
export function useSettingsHostNavigation(target: SettingsNavigationTarget | null) {
  const [visit, setVisit] = useState<{
    choice: ExecutionHostId | null
    nativeAccounts: boolean
  }>({ choice: null, nativeAccounts: false })
  const consumeSettingsNavigation = useCallback((next: SettingsNavigationTarget) => {
    setVisit((previous) => ({
      // Deep links name a transport; the picker is keyed by machine id.
      choice: next.hostScope ? settingsNavigationHostId(next.hostScope) : previous.choice,
      nativeAccounts: next.pane === 'accounts' && next.intent === 'native-accounts'
    }))
  }, [])
  const releaseNativeAccounts = useCallback(() => {
    // An earlier location write cannot clear a later chat-scoped visit.
    setVisit((previous) => (previous === visit ? { ...previous, nativeAccounts: false } : previous))
  }, [visit])
  const setSettingsHostChoice = useCallback((choice: ExecutionHostId) => {
    setVisit({ choice, nativeAccounts: false })
  }, [])
  // Pending navigation owns the first frame, before its effect clears the target.
  return {
    settingsHostChoice: target?.hostScope
      ? settingsNavigationHostId(target.hostScope)
      : visit.choice,
    nativeAccounts: target
      ? target.pane === 'accounts' && target.intent === 'native-accounts'
      : visit.nativeAccounts,
    consumeSettingsNavigation,
    releaseNativeAccounts,
    setSettingsHostChoice
  }
}
