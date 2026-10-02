import type { UISlice } from '@/store/slices/ui'

export function shouldShowWorktreeHistoryControls(activeView: UISlice['activeView']): boolean {
  // Why: every view that records a history entry keeps the back/forward pair, so a full-page view
  // is never left without its own way back out.
  return (
    activeView === 'terminal' ||
    activeView === 'tasks' ||
    activeView === 'automations' ||
    activeView === 'artifacts' ||
    activeView === 'skills' ||
    activeView === 'dashboard'
  )
}
