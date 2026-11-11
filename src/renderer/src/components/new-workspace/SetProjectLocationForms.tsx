import { FolderOpen, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import type { RepoKind } from '../../../../shared/repo-types'

export function ExistingFolderForm({
  setupPath,
  setupKind,
  isSubmitting,
  onPathChange,
  onKindChange,
  onBrowse,
  onSubmit
}: {
  setupPath: string
  setupKind: RepoKind
  isSubmitting: boolean
  onPathChange: (value: string) => void
  onKindChange: (value: RepoKind) => void
  onBrowse: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={setupPath}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={t(
            'auto.components.settings.RepositoryPane.setupExistingFolderPathPlaceholder',
            '/path/to/project/on/host'
          )}
          className="h-9 min-w-0 flex-1 font-mono text-sm"
          spellCheck={false}
          autoFocus
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 shrink-0"
          onClick={onBrowse}
          aria-label={t(
            'auto.components.sidebar.CreateProjectLocationField.f520f83a97',
            'Browse host filesystem'
          )}
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
      <Select value={setupKind} onValueChange={(value) => onKindChange(value as RepoKind)}>
        <SelectTrigger className="h-9 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="git">
            {t('auto.components.settings.RepositoryPane.setupKindGit', 'Git repo')}
          </SelectItem>
          <SelectItem value="folder">
            {t('auto.components.settings.RepositoryPane.setupKindFolder', 'Folder')}
          </SelectItem>
        </SelectContent>
      </Select>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!setupPath.trim() || isSubmitting}
          onClick={onSubmit}
        >
          {isSubmitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {isSubmitting
            ? t('auto.components.settings.RepositoryPane.settingUpHost', 'Importing...')
            : t(
                'auto.components.new.workspace.SetProjectLocationDialog.saveLocation',
                'Set location'
              )}
        </Button>
      </div>
    </div>
  )
}
