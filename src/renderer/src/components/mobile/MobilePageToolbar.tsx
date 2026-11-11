import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

type MobilePageToolbarProps = {
  showMobileButton: boolean
  onToggleMobileSidebarButton: () => void
}

export function MobilePageToolbar({
  showMobileButton,
  onToggleMobileSidebarButton
}: MobilePageToolbarProps): React.JSX.Element {
  const t = useTranslate()
  const sidebarToggleLabel = showMobileButton
    ? t('auto.components.mobile.MobilePageToolbar.c669abcf8f', 'Hide from sidebar')
    : t('auto.components.mobile.MobilePageToolbar.fb5f28330e', 'Show in sidebar')
  const sidebarToggleTooltip = showMobileButton
    ? t('auto.components.mobile.MobilePageToolbar.e1c7b4a92d', 'Configure in Settings > Mobile.')
    : t(
        'auto.components.mobile.MobilePageToolbar.f3d8e5b71a',
        'Adds the shortcut back to the sidebar.'
      )

  return (
    <div className="mp-page-toolbar">
      <div className="mp-page-toolbar-primary">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showMobileButton ? 'default' : 'secondary'}
              size="sm"
              className="mp-sidebar-toggle-btn"
              onClick={onToggleMobileSidebarButton}
              aria-label={sidebarToggleLabel}
            >
              {sidebarToggleLabel}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {sidebarToggleTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
