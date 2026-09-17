import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  resolveAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../../../shared/ai-vault-search-settings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getAgentSessionSearchSearchEntries } from './agent-session-search-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type AgentSessionSearchSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Radix Select rejects an empty value, so "all history" needs a sentinel. */
const ALL_HISTORY_VALUE = 'all'
const HISTORY_DAY_PRESETS = [30, 90, 365]

function retentionValue(historyDays: number | null): string {
  return historyDays === null ? ALL_HISTORY_VALUE : String(historyDays)
}

function retentionDays(value: string): number | null {
  return value === ALL_HISTORY_VALUE ? null : Number(value)
}

/** A CLI-written window outside the presets still has to render as the current choice. */
function retentionDayOptions(historyDays: number | null): number[] {
  const days = [...HISTORY_DAY_PRESETS]
  if (historyDays !== null && !days.includes(historyDays)) {
    days.push(historyDays)
    days.sort((a, b) => a - b)
  }
  return days
}

export function AgentSessionSearchSection({
  settings,
  updateSettings
}: AgentSessionSearchSectionProps): React.JSX.Element {
  const current = resolveAiVaultSearchSettings(settings)
  const update = (patch: Partial<AiVaultSearchSettings>): void => {
    updateSettings({ aiVaultSearch: { ...current, ...patch } })
  }
  const contentTitle = translate(
    'auto.components.settings.AgentSessionSearchSection.contentTitle',
    'Index conversation content'
  )
  const contentDescription = translate(
    'auto.components.settings.AgentSessionSearchSection.contentDescription',
    'Indexes session titles, working directories, branches, and message text from transcripts on this machine. When off, search covers titles and paths but not conversation contents.'
  )
  const retentionTitle = translate(
    'auto.components.settings.AgentSessionSearchSection.retentionTitle',
    'History range'
  )
  const retentionDescription = translate(
    'auto.components.settings.AgentSessionSearchSection.retentionDescription',
    'How far back to index transcripts. All history indexes every transcript the scan can find.'
  )
  const keywords = getAgentSessionSearchSearchEntries().flatMap((entry) => [
    entry.title,
    entry.description ?? '',
    ...(entry.keywords ?? [])
  ])

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.AgentSessionSearchSection.title',
          'Session History Search'
        )}
        description={translate(
          'auto.components.settings.AgentSessionSearchSection.description',
          'Search your local agent sessions by title, project, and conversation content.'
        )}
      />

      <SearchableSetting title={contentTitle} description={contentDescription} keywords={keywords}>
        <SettingsSwitchRow
          label={contentTitle}
          description={contentDescription}
          checked={current.contentEnabled}
          onChange={() => update({ contentEnabled: !current.contentEnabled })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={retentionTitle}
        description={retentionDescription}
        keywords={keywords}
      >
        <SettingsRow
          label={retentionTitle}
          description={retentionDescription}
          control={
            <Select
              value={retentionValue(current.historyDays)}
              onValueChange={(value) => update({ historyDays: retentionDays(value) })}
            >
              <SelectTrigger size="sm" aria-label={retentionTitle}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_HISTORY_VALUE}>
                  {translate(
                    'auto.components.settings.AgentSessionSearchSection.allHistory',
                    'All history'
                  )}
                </SelectItem>
                {retentionDayOptions(current.historyDays).map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {translate(
                      'auto.components.settings.AgentSessionSearchSection.lastDays',
                      'Last {{value0}} days',
                      { value0: days }
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>
    </section>
  )
}
