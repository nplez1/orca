import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'
import { migrateStatusBarItems } from './ui-slice-hydration-sanitizers'

const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'
const DEFAULT_ON_COPILOT_STATUS_BAR_ITEM: StatusBarItem = 'copilot'

// Why: default-on status items ship as one-shot migrations so an existing
// profile gains the new item instead of only fresh installs seeing it.
const DEFAULT_ON_STATUS_BAR_MIGRATIONS = [
  ['_portsStatusBarDefaultAdded', DEFAULT_ON_PORTS_STATUS_BAR_ITEM],
  ['_kimiStatusBarDefaultAdded', DEFAULT_ON_KIMI_STATUS_BAR_ITEM],
  ['_minimaxStatusBarDefaultAdded', DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM],
  ['_antigravityStatusBarDefaultAdded', DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM],
  ['_grokStatusBarDefaultAdded', DEFAULT_ON_GROK_STATUS_BAR_ITEM],
  ['_copilotStatusBarDefaultAdded', DEFAULT_ON_COPILOT_STATUS_BAR_ITEM]
] as const

export function hydrateStatusBarItems(ui: PersistedUIState): StatusBarItem[] {
  let items = migrateStatusBarItems(ui.statusBarItems)
  for (const [flag, item] of DEFAULT_ON_STATUS_BAR_MIGRATIONS) {
    if (!ui[flag] && !items.includes(item)) {
      items = [...items, item]
    }
  }
  if (
    typeof window !== 'undefined' &&
    DEFAULT_ON_STATUS_BAR_MIGRATIONS.some(([flag]) => !ui[flag])
  ) {
    window.api.ui
      .set({
        statusBarItems: items,
        ...Object.fromEntries(DEFAULT_ON_STATUS_BAR_MIGRATIONS.map(([flag]) => [flag, true]))
      })
      .catch(console.error)
  }
  return items
}
