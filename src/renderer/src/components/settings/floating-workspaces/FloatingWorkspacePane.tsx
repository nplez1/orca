import { useEffect, useState } from 'react'
import { FolderOpen, FolderSearch } from 'lucide-react'
import { toast } from 'sonner'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { FloatingTerminalTriggerLocation } from '../../../../../shared/ui-chrome-types'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getFloatingWorkspaceSearchEntries } from './floating-workspace-search'
import { matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { translate } from '@/i18n/i18n'

type FloatingWorkspacePaneProps = {
  settings: Pick<
    GlobalSettings,
    'floatingTerminalCwd' | 'floatingTerminalEnabled' | 'floatingTerminalTriggerLocation'
  >
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: the settings panes share one reveal label, so the platform copy keeps one translation each.
function getRevealDirectoryLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return translate('auto.components.settings.CliSection.6f894ef9c2', 'Show in Finder')
  }
  if (platform === 'win32') {
    return translate('auto.components.settings.CliSection.cbe55e4d48', 'Show in Explorer')
  }
  return translate('auto.components.settings.CliSection.9fd4023db0', 'Show in File Manager')
}

export function FloatingWorkspacePane({
  settings,
  updateSettings
}: FloatingWorkspacePaneProps): React.JSX.Element | null {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const includeBrowser = !isWebClientLocation()
  const [resolvedFloatingWorkspacePath, setResolvedFloatingWorkspacePath] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getFloatingTerminalCwd({
        path: settings.floatingTerminalCwd
      })
      .then((path) => {
        if (!cancelled) {
          setResolvedFloatingWorkspacePath(path)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedFloatingWorkspacePath('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [settings.floatingTerminalCwd])

  const pickFloatingWorkspaceDirectory = async (): Promise<void> => {
    const path = await window.api.app.pickFloatingWorkspaceDirectory()
    if (!path) {
      return
    }
    useAppStore.getState().recordFeatureInteraction('floating-workspace')
    updateSettings({ floatingTerminalCwd: path })
  }

  const revealDirectoryLabel = getRevealDirectoryLabel(getRendererAppPlatform())

  const revealFloatingWorkspaceDirectory = async (): Promise<void> => {
    if (!resolvedFloatingWorkspacePath) {
      return
    }
    const result = await window.api.shell.openInFileManager(
      resolvedFloatingWorkspacePath,
      LOCAL_EXECUTION_HOST_ID
    )
    if (!result.ok) {
      toast.error(
        t(
          'auto.components.settings.FloatingWorkspacePane.revealFailed',
          'Could not open the floating workspace folder.'
        )
      )
    }
  }

  if (!matchesSettingsSearch(searchQuery, getFloatingWorkspaceSearchEntries({ includeBrowser }))) {
    return null
  }

  return (
    <section className="space-y-4">
      <SearchableSetting
        title={t('auto.components.settings.FloatingWorkspacePane.2374e81dd8', 'Floating workspace')}
        description={t(
          'auto.components.settings.FloatingWorkspacePane.37df688d6f',
          'Enable the floating workspace and choose where new tabs start.'
        )}
        keywords={[
          'floating workspace',
          'floating terminal',
          'terminal',
          ...(includeBrowser ? ['browser'] : []),
          'markdown',
          'note',
          'global',
          'quick panel',
          'launch directory'
        ]}
        className="divide-y divide-border/40"
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.FloatingWorkspacePane.172d1d75c3',
            'Enable floating workspace'
          )}
          description={t(
            'auto.components.settings.FloatingWorkspacePane.41eb95f7f0',
            'Shows the floating workspace button and panel.'
          )}
          checked={settings.floatingTerminalEnabled}
          onChange={() => {
            if (!settings.floatingTerminalEnabled) {
              useAppStore.getState().recordFeatureInteraction('floating-workspace')
            } else {
              useAppStore.getState().recordFeatureInteraction('floating-workspace-hidden')
            }
            updateSettings({
              floatingTerminalEnabled: !settings.floatingTerminalEnabled
            })
          }}
        />

        <SettingsRow
          alignTop
          label={t(
            'auto.components.settings.FloatingWorkspacePane.7cedc178d6',
            'Terminal directory'
          )}
          description={t(
            'auto.components.settings.FloatingWorkspacePane.81afb79785',
            'New floating terminals and agents start here. Floating markdown notes always live in the floating-workspace folder, next to its AGENTS.md instructions.'
          )}
          control={
            <div className="flex w-72 max-w-full gap-2">
              <Input value={resolvedFloatingWorkspacePath} readOnly className="min-w-0 flex-1" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={revealDirectoryLabel}
                disabled={!resolvedFloatingWorkspacePath}
                onClick={() => void revealFloatingWorkspaceDirectory()}
              >
                <FolderSearch className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t(
                  'auto.components.settings.FloatingWorkspacePane.505001823e',
                  'Choose floating workspace directory'
                )}
                onClick={() => void pickFloatingWorkspaceDirectory()}
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          }
        />

        <SettingsRow
          label={t(
            'auto.components.settings.FloatingWorkspacePane.b9c2a85346',
            'Toggle button location'
          )}
          description={t(
            'auto.components.settings.FloatingWorkspacePane.3c900e26e5',
            'The keyboard shortcut works regardless of where the toggle is shown.'
          )}
          control={
            <ToggleGroup
              type="single"
              value={settings.floatingTerminalTriggerLocation ?? 'floating-button'}
              onValueChange={(value) => {
                if (!value) {
                  return
                }
                updateSettings({
                  floatingTerminalTriggerLocation: value as FloatingTerminalTriggerLocation
                })
                useAppStore.getState().recordFeatureInteraction('floating-workspace')
              }}
            >
              <ToggleGroupItem value="floating-button">
                {t('auto.components.settings.FloatingWorkspacePane.73ac917638', 'Floating button')}
              </ToggleGroupItem>
              <ToggleGroupItem value="status-bar">
                {t('auto.components.settings.FloatingWorkspacePane.dd7eb9270a', 'Status bar')}
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SearchableSetting>
    </section>
  )
}
