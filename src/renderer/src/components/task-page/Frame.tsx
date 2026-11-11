import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageListChrome } from './ListChrome'
import { TaskPageContent } from './Content'
export function TaskPageFrame({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Owns the top band, so it reserves it — including the window controls a detail view would sit under. */}
      <div className="mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col px-5 pt-[max(1.25rem,var(--content-top-controls-inset,0px))] pb-4 md:px-8 md:pt-[max(1.5rem,var(--content-top-controls-inset,0px))] md:pb-5">
        <TaskPageListChrome model={model} />

        <TaskPageContent model={model} />
      </div>
    </div>
  )
}
