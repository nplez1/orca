import { Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  SettingsSegmentedControl,
  SettingsSwitch
} from '../settings/form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

/** Board-header settings for the Agent Dashboard, mirroring the workspace
 *  board's settings menu. */
export function AgentDashboardSettingsMenu(): React.JSX.Element {
  const t = useTranslate()
  const showIdle = useAppStore((s) => s.settings?.experimentalAgentDashboardShowIdle === true)
  const cardClickAction = useAppStore(
    (s) => s.settings?.experimentalAgentDashboardCardClickAction ?? 'workspace'
  )
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('dashboardPopout.settingsLabel', 'Agent Dashboard settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('dashboardPopout.settingsTooltip', 'Board settings')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-72 p-2">
        <div className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1.5">
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[12px] font-medium leading-4 text-foreground">
              {t(
                'auto.components.settings.ExperimentalPane.agentDashboard.clickLabel',
                'Clicking a card'
              )}
            </span>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              {t(
                'auto.components.settings.ExperimentalPane.agentDashboard.clickCopy',
                "Open the agent's workspace, or show the live terminal preview first."
              )}
            </span>
          </span>
        </div>
        <div className="px-1.5 pb-1">
          <SettingsSegmentedControl
            value={cardClickAction}
            onChange={(next) => updateSettings({ experimentalAgentDashboardCardClickAction: next })}
            ariaLabel={t(
              'auto.components.settings.ExperimentalPane.agentDashboard.clickAriaLabel',
              'Agent Dashboard card click action'
            )}
            size="sm"
            equalWidth
            options={[
              {
                value: 'workspace',
                label: t(
                  'auto.components.settings.ExperimentalPane.agentDashboard.clickWorkspace',
                  'Open workspace'
                )
              },
              {
                value: 'preview',
                label: t(
                  'auto.components.settings.ExperimentalPane.agentDashboard.clickPreview',
                  'Preview'
                )
              }
            ]}
          />
        </div>
        <DropdownMenuSeparator />
        <div className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1.5">
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[12px] font-medium leading-4 text-foreground">
              {t('dashboardPopout.settings.showIdle', 'Show idle agents')}
            </span>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              {t(
                'dashboardPopout.settings.showIdleCopy',
                'Include agents that have gone quiet for 30 minutes without reporting completion. Hidden by default.'
              )}
            </span>
          </span>
          <SettingsSwitch
            checked={showIdle}
            onChange={() => {
              void updateSettings({ experimentalAgentDashboardShowIdle: !showIdle })
            }}
            ariaLabel={t('dashboardPopout.settings.showIdle', 'Show idle agents')}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
