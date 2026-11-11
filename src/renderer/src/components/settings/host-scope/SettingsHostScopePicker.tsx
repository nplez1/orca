import { useTranslate } from '@/i18n/use-translate'
import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectGroup,
  type SettingsSearchableSelectOption
} from '../form-controls/SettingsSearchableSelect'
import type { SettingsHostScope, SettingsHostScopeHost } from './settings-host-scope'

type SettingsHostScopePickerProps = {
  scope: SettingsHostScope
  hosts: readonly SettingsHostScopeHost[]
  onChoose: (hostId: ExecutionHostId) => void
}

/** A merged SSH row stands for the server it deploys, so it belongs with the servers. */
function hasServer(host: SettingsHostScopeHost): boolean {
  const parsed = parseExecutionHostId(host.id)
  if (parsed?.kind === 'runtime') {
    return true
  }
  return (host.aliasHostIds ?? []).some((alias) => parseExecutionHostId(alias)?.kind === 'runtime')
}

function pickerGroupFor(host: SettingsHostScopeHost): 'computer' | 'servers' | 'machines' {
  const parsed = parseExecutionHostId(host.id)
  if (parsed?.kind === 'local') {
    return 'computer'
  }
  return hasServer(host) ? 'servers' : 'machines'
}

/** Local-only users need no picker; any second machine, server or SSH, makes it useful. */
export function shouldShowSettingsHostScopePicker(
  scope: SettingsHostScope,
  hosts: readonly SettingsHostScopeHost[]
): boolean {
  return (
    scope.hostId !== LOCAL_EXECUTION_HOST_ID ||
    hosts.some((host) => host.id !== LOCAL_EXECUTION_HOST_ID)
  )
}

export function SettingsHostScopePicker({
  scope,
  hosts,
  onChoose
}: SettingsHostScopePickerProps): React.JSX.Element {
  const t = useTranslate()
  const rows: SettingsHostScopeHost[] = hosts.some((host) => host.id === LOCAL_EXECUTION_HOST_ID)
    ? [...hosts]
    : [{ id: LOCAL_EXECUTION_HOST_ID, label: getLocalExecutionHostLabel() }, ...hosts]
  const optionFor = (host: SettingsHostScopeHost): SettingsSearchableSelectOption => ({
    value: host.id,
    label: host.label,
    keywords: [host.id]
  })
  const grouped: SettingsSearchableSelectGroup[] = [
    {
      key: 'computer',
      heading: t('auto.components.settings.SettingsHostScopePicker.thisComputer', 'This computer'),
      options: rows.filter((host) => pickerGroupFor(host) === 'computer').map(optionFor)
    },
    {
      key: 'servers',
      heading: t('auto.components.settings.SettingsHostScopePicker.servers', 'Orca servers'),
      options: rows.filter((host) => pickerGroupFor(host) === 'servers').map(optionFor)
    },
    {
      key: 'machines',
      heading: t(
        'auto.components.settings.SettingsHostScopePicker.machines',
        'Machines without a server'
      ),
      options: rows.filter((host) => pickerGroupFor(host) === 'machines').map(optionFor)
    }
  ].filter((group) => group.options.length > 0)
  // A removed server or an id the registry dropped must stay visible, never silently rebound.
  if (!scope.available || !rows.some((host) => host.id === scope.hostId)) {
    grouped.push({
      key: 'unavailable',
      options: [
        {
          value: scope.hostId,
          label: scope.available
            ? t('auto.components.settings.SettingsHostScopePicker.loading', 'Loading hosts…')
            : t(
                'auto.components.settings.SettingsHostScopePicker.unavailable',
                '{{value0}} (unavailable)',
                { value0: scope.label }
              ),
          keywords: [scope.hostId],
          disabled: true
        }
      ]
    })
  }
  const label = t('auto.components.settings.SettingsHostScopePicker.label', 'Host')
  return (
    <div className="flex min-w-0 items-center text-settings-detail">
      <span className="sr-only">{label}</span>
      <SettingsSearchableSelect
        compact
        ariaLabel={label}
        value={scope.hostId}
        groups={grouped}
        searchPlaceholder={t(
          'auto.components.settings.SettingsSearchableSelect.searchHosts',
          'Search hosts…'
        )}
        onValueChange={(next) => {
          const hostId = parseExecutionHostId(next)?.id
          if (hostId) {
            onChoose(hostId)
          }
        }}
      />
    </div>
  )
}

/** Shown in place of a host-owned pane whose chosen server is no longer saved. */
export function SettingsHostScopeUnavailableNotice(): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-sm text-muted-foreground">
      {t(
        'auto.components.settings.SettingsHostScopePicker.unavailableNotice',
        'This server is no longer saved, so nothing can be shown for it. Choose another host at the top of Settings.'
      )}
    </p>
  )
}

/** Shown in place of a server-backed pane when the chosen machine runs no Orca server. */
export function SettingsHostScopeMachineOnlyNotice({
  hostLabel
}: {
  hostLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-sm text-muted-foreground">
      {t(
        'auto.components.settings.SettingsHostScopePicker.machineOnlyNotice',
        '{{value0}} has no Orca server, so its server settings cannot be shown here. Choose this computer or one of its servers at the top of Settings.',
        { value0: hostLabel }
      )}
    </p>
  )
}
