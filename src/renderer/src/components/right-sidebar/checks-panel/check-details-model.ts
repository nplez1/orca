import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import type { CheckDetailsErrorAction } from '@/lib/check-details-error-action'
import {
  checkDetailsRowKey,
  type CheckDetailsRowState
} from '@/components/github/check-details-cache'
import { getCheckConclusion } from '../../../../../shared/pr-check-status-label'

export type CheckDetailsLoadState = {
  requestId?: number
  loading: boolean
  /** Held while a refresh runs: the pane keeps rendering it instead of a spinner. */
  details: PRCheckRunDetails | null
  error: string | null
  /** Settings affordance for the error, when the failure is one the user can fix. */
  errorAction?: CheckDetailsErrorAction | null
  /** Clock and row state of the read behind `details` — staleness inputs, never rendered. */
  readAt?: number
  readFor?: CheckDetailsRowState
}

export function getCheckDetailsKey(
  contextKey: string,
  check: PRCheckDetail,
  index: number
): string {
  // Why: manual/created GitLab jobs may have neither id nor web_url, so they would otherwise key on
  // the list index and lose their cached log whenever the pipeline re-sorts.
  return `${contextKey}::${checkDetailsRowKey(check, index)}`
}

export function isFailedCheck(check: PRCheckDetail): boolean {
  // action_required blocks merge; counting it as passing would contradict auto-merge readiness.
  return ['failure', 'cancelled', 'timed_out', 'action_required'].includes(
    getCheckConclusion(check)
  )
}

export function formatCheckTimestamp(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Elapsed time between two provider timestamps, or null when either is missing or unparseable. */
export function getCheckDurationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined
): number | null {
  if (!startedAt || !completedAt) {
    return null
  }
  const started = new Date(startedAt).getTime()
  const completed = new Date(completedAt).getTime()
  if (Number.isNaN(started) || Number.isNaN(completed) || completed < started) {
    return null
  }
  return completed - started
}

export function getFailedChecksForDetails(checks: PRCheckDetail[]): PRCheckDetail[] {
  return checks.filter(isFailedCheck)
}

export type CheckDetailsStickySurface = 'sidebar' | 'card'

export function getCheckDetailsStickySurfaceClass(surface: CheckDetailsStickySurface): string {
  return surface === 'card' ? 'bg-card/95' : 'bg-sidebar/95'
}
