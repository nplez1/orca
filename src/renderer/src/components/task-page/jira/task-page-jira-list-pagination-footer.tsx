import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { TaskPageJiraListPage } from './task-page-jira-list-pagination'

/** Says what the rendered list leaves out, and continues it when one cursor can.
 *  No continuation means no single cursor reaches the rest — several sites, a Cloud
 *  preset spanning several project chunks, or a host without the page methods — so the
 *  copy asks for a narrower filter rather than promising a control this view cannot offer. */
export function TaskPageJiraListPaginationFooter({
  page,
  shownCount,
  loadingMore,
  error,
  onLoadMore
}: {
  page: TaskPageJiraListPage | null
  shownCount: number
  loadingMore: boolean
  error: string | null
  onLoadMore: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-center gap-2 border-t border-border/50 px-4 py-3 text-xs text-destructive"
      >
        <span>{error}</span>
        <Button type="button" variant="ghost" size="xs" onClick={onLoadMore}>
          {t('auto.components.TaskPage.jiraListRetryLoadMore', 'Try again')}
        </Button>
      </div>
    )
  }
  if (!page?.hasMore) {
    return null
  }
  if (!page.continuation) {
    return (
      <p
        role="status"
        className="border-t border-border/50 px-4 py-3 text-center text-xs text-muted-foreground"
      >
        {t(
          'auto.components.TaskPage.jiraListTruncated',
          'Showing the first {{count}} — refine the filter to see the rest.',
          { count: shownCount }
        )}
      </p>
    )
  }
  return (
    <div className="flex justify-center border-t border-border/50 p-3">
      <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
        {loadingMore ? (
          <>
            <LoaderCircle className="mr-1.5 size-3.5 animate-spin" />
            {t('auto.components.TaskPage.jiraBoardLoadingMore', 'Loading…')}
          </>
        ) : (
          t('auto.components.TaskPage.jiraLoadMoreIssues', 'Load more issues')
        )}
      </Button>
    </div>
  )
}
