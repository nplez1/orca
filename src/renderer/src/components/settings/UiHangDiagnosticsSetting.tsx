import { useEffect, useState } from 'react'
import type { UiHangDiagnosticsStatus } from '../../../../shared/ui-hang-diagnostics-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getAdvancedSearchEntry } from './advanced-search'

type UiHangDiagnosticsSettingProps = {
  enabled: boolean
  onToggle: () => void
}

export function UiHangDiagnosticsSetting({
  enabled,
  onToggle
}: UiHangDiagnosticsSettingProps): React.JSX.Element {
  const [status, setStatus] = useState<UiHangDiagnosticsStatus | null>(null)
  const searchEntry = getAdvancedSearchEntry().uiHangDiagnostics

  // Why refetch on toggle: consent (CI / ORCA_DIAGNOSTICS_DISABLED) is main-side state the
  // renderer cannot read, so the disabled reason only arrives with the status.
  useEffect(() => {
    let cancelled = false
    void window.api.uiHangDiagnostics
      .getStatus()
      .then((next) => {
        if (!cancelled) {
          setStatus(next)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return (
    <SearchableSetting
      title={searchEntry.title}
      description={searchEntry.description}
      keywords={searchEntry.keywords}
      className="space-y-2 py-2"
      id="advanced-ui-hang-logging"
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.UiHangDiagnosticsSetting.7879895603',
          'Log UI hangs'
        )}
        description={translate(
          'auto.components.settings.UiHangDiagnosticsSetting.38d00b7a2e',
          'Off by default. Records UI-thread stalls and window freezes so you can share them when reporting a hang.'
        )}
        checked={enabled}
        onChange={onToggle}
      />
      {enabled && status?.logFilePath ? (
        <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
          <p className="text-xs font-medium">
            {translate('auto.components.settings.UiHangDiagnosticsSetting.e19f83d807', 'Log file')}
          </p>
          <p className="select-text break-all font-mono text-xs text-muted-foreground">
            {status.logFilePath}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.UiHangDiagnosticsSetting.9fa69c4cae',
              'Written while logging is on.'
            )}
          </p>
          {status.disabledReason ? (
            <p className="mt-1 text-xs text-destructive">
              {translate(
                'auto.components.settings.UiHangDiagnosticsSetting.2b5bd8a767',
                'Local log writes are disabled by policy (CI or ORCA_DIAGNOSTICS_DISABLED).'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </SearchableSetting>
  )
}
