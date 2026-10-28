import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getSettingsFocusedExecutionHostId } from '../../../shared/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

type DefaultHostSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

function readDefaultHost(settings: DefaultHostSettings): RuntimeClientTarget {
  return (
    ipcOrRuntimeTargetForHostId(getSettingsFocusedExecutionHostId(settings)) ?? { kind: 'local' }
  )
}

/**
 * The "Default host for new projects" setting. Only a creation flow with no source row reads it;
 * everything else routes by the resource's owner.
 */
export function defaultCreationHost(settings: DefaultHostSettings): RuntimeClientTarget {
  return readDefaultHost(settings)
}

/**
 * Initial host of a row-less source (Linear, Jira, the status-bar account switchers) or a settings
 * scope, until the page's own host picker overrides it.
 */
export function defaultScopeHost(settings: DefaultHostSettings): RuntimeClientTarget {
  return readDefaultHost(settings)
}
