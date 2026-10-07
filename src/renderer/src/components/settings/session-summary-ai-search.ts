import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getSessionSummaryAiSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.sessionSummaryAi.title', 'Session summaries'),
    description: translate(
      'settings.sessionSummaryAi.description',
      'The agent and model that summarize a session in the Summary tab. A fold runs only while that tab is open, reads only what was added since the last fold, and its result is cached.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.sessionSummaryAi.keyword.summary', 'summary'),
      ...translateSearchKeyword('settings.sessionSummaryAi.keyword.agent', 'agent'),
      ...translateSearchKeyword('settings.sessionSummaryAi.keyword.model', 'model'),
      ...translateSearchKeyword('settings.sessionSummaryAi.keyword.transcript', 'transcript')
    ]
  }
])
