import { BookOpen, Download, History, Link2, MoreHorizontal, Share2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { skillCountLabel } from '../presentation/skill-display-labels'
import { SKILLS_PAGE_COLUMN, SKILLS_PAGE_TOP_ROW_INSET } from './skills-page-column'
import { SkillsSourcesPopover } from './SkillsSourcesPopover'
import type { SkillSourceInventoryEntry } from './skill-source-inventory'

export function SkillsPageHeader({
  skillCount,
  sourceEntries,
  scannedSourceCount,
  hostLabel,
  onStartShare,
  deleteSupported,
  deleteUnsupportedReason,
  onStartDelete,
  onInstallFromLink,
  onManageInstalls,
  onOpenSharedLinks
}: {
  skillCount: number
  sourceEntries: readonly SkillSourceInventoryEntry[]
  scannedSourceCount: number
  hostLabel: string | null
  onStartShare: () => void
  /** Disable deletion with a reason until the target and host capability are known. */
  deleteSupported: boolean
  deleteUnsupportedReason: string | null
  onStartDelete: () => void
  onInstallFromLink: () => void
  onManageInstalls: () => void
  onOpenSharedLinks: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <header className="shrink-0 border-b border-border">
      <div
        className={cn(
          SKILLS_PAGE_COLUMN,
          SKILLS_PAGE_TOP_ROW_INSET,
          'flex items-center gap-2 py-3'
        )}
      >
        <BookOpen className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {t('auto.components.skills.SkillsPage.f43ad6edf3', 'Skills')}
          </h1>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{skillCountLabel(skillCount, t)}</span>
            {sourceEntries.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <SkillsSourcesPopover entries={sourceEntries} scannedCount={scannedSourceCount} />
              </>
            ) : null}
            {hostLabel ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{hostLabel}</span>
              </>
            ) : null}
          </div>
        </div>
        <Button type="button" size="sm" onClick={onStartShare}>
          <Share2 className="size-3.5" />
          {t('auto.components.skills.SkillShareSelectionControls.01c5a15e02', 'Share skills')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onInstallFromLink}>
          <Download className="size-3.5" />
          {t('auto.components.skills.SkillsPage.aee7b99cc6', 'Install from link')}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('auto.components.skills.SkillsPage.moreActions', 'More actions')}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onManageInstalls}>
              <History />
              {t('auto.components.skills.SkillsPage.c13b82793c', 'Manage installs')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenSharedLinks}>
              <Link2 />
              {t('auto.components.skills.SkillsPage.sharedLinks', 'Shared links')}
            </DropdownMenuItem>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="pointer-events-auto block">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={!deleteSupported}
                    onSelect={onStartDelete}
                  >
                    <Trash2 />
                    {t('auto.components.skills.SkillsPage.deleteSkills', 'Delete skills…')}
                  </DropdownMenuItem>
                </span>
              </TooltipTrigger>
              {deleteSupported || !deleteUnsupportedReason ? null : (
                <TooltipContent side="left" sideOffset={4}>
                  {deleteUnsupportedReason}
                </TooltipContent>
              )}
            </Tooltip>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
