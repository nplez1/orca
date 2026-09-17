import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAgentSessionSearchSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.agent-session-search-search.title',
      'Session History Search'
    ),
    description: translate(
      'auto.components.settings.agent-session-search-search.description',
      'Index agent session transcripts so conversations are searchable on this machine.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.session',
        'session'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.history',
        'history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.search',
        'search'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.transcript',
        'transcript'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.index',
        'index'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.conversation',
        'conversation'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.content',
        'content'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agent-session-search-search.retention',
        'retention'
      )
    ]
  }
])
