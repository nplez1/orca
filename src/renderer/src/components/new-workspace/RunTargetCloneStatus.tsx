import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import type { RunTargetAutoClone } from './use-run-target-auto-clone'

/**
 * What the host the user just picked is doing, under the picker.
 *
 * The picker closes on selection, so this line is where a clone's progress and its recovery live:
 * the row carries the same state for when the picker is reopened, but the actions that need room
 * (Retry, Use existing folder, Clone as) are here.
 */
export function RunTargetCloneStatus({
  clone,
  onUseExistingFolder
}: {
  clone: RunTargetAutoClone
  onUseExistingFolder: (option: NeedsSetupProjectHostOption, initialPath?: string) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { status } = clone
  if (status.kind === 'idle') {
    return null
  }
  const host = status.target.label
  if (status.kind === 'cloning') {
    return (
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      >
        <LoaderCircle className="size-3 animate-spin" />
        {t('auto.components.NewWorkspaceComposerCard.cloningOntoHost', 'Cloning onto {{host}}…', {
          host
        })}
      </p>
    )
  }
  if (status.kind === 'folder-taken') {
    return (
      <div role="status" aria-live="polite" className="space-y-1">
        <p className="text-[11px] text-muted-foreground">
          {t(
            'auto.components.NewWorkspaceComposerCard.cloneFolderTaken',
            '{{folder}} already exists on {{host}}.',
            { folder: status.folderName, host }
          )}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => clone.cloneAs(status.suggestion)}
          >
            {t('auto.components.NewWorkspaceComposerCard.cloneAsSuggestion', 'Clone as {{name}}', {
              name: status.suggestion
            })}
          </Button>
          {status.canUseExistingFolder ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onUseExistingFolder(status.target.option, status.path)}
            >
              {t(
                'auto.components.NewWorkspaceComposerCard.useExistingFolder',
                'Use existing folder'
              )}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <div role="status" aria-live="polite" className="space-y-1">
      <p className="text-[11px] text-destructive">{status.message}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="outline" size="xs" onClick={clone.retry}>
          {t('auto.components.NewWorkspaceComposerCard.retryClone', 'Retry')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onUseExistingFolder(status.target.option)}
        >
          {t('auto.components.NewWorkspaceComposerCard.useExistingFolder', 'Use existing folder')}
        </Button>
      </div>
    </div>
  )
}
