import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TaskPageListChrome } from './ListChrome'
import { TaskPageContent } from './Content'
export function TaskPageFrame({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Why: pt-1.5 (6px) puts this 32px icon cluster's center 22px below the window's top edge — the same first-row height the dashboard uses, now that Tasks owns the top edge instead of sitting under an empty titlebar stripe. */}
      <div className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col px-5 pt-1.5 pb-4 md:px-8 md:pt-1.5 md:pb-5">
        <TaskPageListChrome model={model} />

        <TaskPageContent model={model} />
      </div>
    </div>
  )
}
