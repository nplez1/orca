import { LoaderCircle, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

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
  return (
    <div className="grid gap-2">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.JiraIssueWorkspace.444865b4a8', 'Title')}
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
      <label className="mt-2 text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.JiraIssueWorkspace.aee97b6913', 'Labels')}
      </label>
      <div className="flex gap-2">
        <Input
          value={labelsDraft}
          onChange={(event) => setLabelsDraft(event.target.value)}
          placeholder={translate('auto.components.JiraIssueWorkspace.0f3c07a901', 'backend, bug')}
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
