import { LoaderCircle, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'

/** Title + labels editor for an open Jira issue, shared by the Task view's
 *  `JiraIssueWorkspaceContent` and the right-sidebar Issue pane. */
export function JiraIssueTitleLabelsEditor({
  titleDraft,
  setTitleDraft,
  labelsDraft,
  setLabelsDraft,
  handleSaveTitle,
  handleSaveLabels,
  pendingField
}: {
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  handleSaveTitle: () => void
  handleSaveLabels: () => void
  pendingField: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="grid gap-2">
      <label className="text-2xs font-medium text-muted-foreground">
        {t('auto.components.JiraIssueWorkspace.444865b4a8', 'Title')}
      </label>
      <div className="flex gap-2">
        <Input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              handleSaveTitle()
            }
          }}
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleSaveTitle}
          disabled={pendingField === 'title'}
        >
          {pendingField === 'title' ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
        </Button>
      </div>
      <label className="mt-2 text-2xs font-medium text-muted-foreground">
        {t('auto.components.JiraIssueWorkspace.aee97b6913', 'Labels')}
      </label>
      <div className="flex gap-2">
        <Input
          value={labelsDraft}
          onChange={(event) => setLabelsDraft(event.target.value)}
          placeholder={t('auto.components.JiraIssueWorkspace.0f3c07a901', 'backend, bug')}
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleSaveLabels}
          disabled={pendingField === 'labels'}
        >
          {pendingField === 'labels' ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
        </Button>
      </div>
    </div>
  )
}
