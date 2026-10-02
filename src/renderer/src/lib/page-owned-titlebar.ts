import type { AppState } from '@/store/types'

type ActiveView = AppState['activeView']

/**
 * Views whose page draws its own top edge. The shell must not stack the 36px
 * center titlebar above them: it would be an empty stripe holding nothing but
 * the window-controls spacer, pushing the page's first row down.
 */
const PAGE_OWNED_TITLEBAR_VIEWS = new Set<ActiveView>(['automations', 'artifacts', 'dashboard'])

export function pageOwnsTitlebar(activeView: ActiveView): boolean {
  return PAGE_OWNED_TITLEBAR_VIEWS.has(activeView)
}
