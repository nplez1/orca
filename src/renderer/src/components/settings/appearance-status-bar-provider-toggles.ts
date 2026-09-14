import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { getAntigravityStatusBarToggleSearchEntry } from './appearance-status-bar-antigravity-toggle-search'
import { getGrokStatusBarToggleSearchEntry } from './appearance-status-bar-grok-toggle-search'

export type StatusBarToggleSearchEntry = {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}

// Why: provider toggles live here because this list grows by one default-on
// provider at a time and otherwise pushes the catalog past its line budget.
export function getProviderUsageStatusBarToggleEntries(): StatusBarToggleSearchEntry[] {
  return [
    {
      id: 'claude',
      title: translate('auto.components.settings.appearance.search.9dc15020d7', 'Claude Usage'),
      description: translate(
        'auto.components.settings.appearance.search.de50c6f516',
        'Show Claude token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.c9fe3a7876',
          'claude'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.dea0a9a665',
          'anthropic'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.claudeToggleDescription',
        'Show Claude token and cost usage for the active workspace.'
      )
    },
    {
      id: 'codex',
      title: translate('auto.components.settings.appearance.search.54b1acf24f', 'Codex Usage'),
      description: translate(
        'auto.components.settings.appearance.search.e9e4412545',
        'Show Codex token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.8dfd676c28', 'codex'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.97957e374e', 'openai')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.codexToggleDescription',
        'Show Codex token and cost usage for the active workspace.'
      )
    },
    {
      id: 'gemini',
      title: translate('auto.components.settings.appearance.search.5bfb874d05', 'Gemini Usage'),
      description: translate(
        'auto.components.settings.appearance.search.9660c5b2f1',
        'Show Gemini token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.2804a920ad',
          'gemini'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.51b0ccd6a2', 'google')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.geminiToggleDescription',
        'Show Gemini token and cost usage for the active workspace.'
      )
    },
    getAntigravityStatusBarToggleSearchEntry(),
    {
      id: 'opencode-go',
      title: translate(
        'auto.components.settings.appearance.search.bc046e7899',
        'OpenCode Go Usage'
      ),
      description: translate(
        'auto.components.settings.appearance.search.7f72de7cbe',
        'Show OpenCode Go token and cost usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.a9d56852eb',
          'opencode'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.d77537b580',
          'opencode-go'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.afbb6a3767',
          'tokens'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.opencodeGoToggleDescription',
        'Show OpenCode Go token and cost usage for the active workspace.'
      )
    },
    {
      id: 'kimi',
      title: translate('auto.components.settings.appearance.search.3a6c028ea8', 'Kimi Usage'),
      description: translate(
        'auto.components.settings.appearance.search.c927a155d5',
        'Show Kimi subscription usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.40e5c3c285', 'kimi'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.de586def95',
          'subscription'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.35565867cb',
          'moonshot'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.kimiToggleDescription',
        'Show Kimi subscription usage for the active workspace.'
      )
    },
    {
      id: 'minimax',
      title: translate('auto.components.settings.appearance.search.0f08f6b483', 'MiniMax Usage'),
      description: translate(
        'auto.components.settings.appearance.search.e46178eb1b',
        'Show MiniMax subscription usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.d16378a88f',
          'minimax'
        ),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.de586def95',
          'subscription'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.d9e7cef86f',
          'cookie'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.25e51b62ee',
          'rate limit'
        )
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.minimaxToggleDescription',
        'Show MiniMax subscription usage for the active workspace.'
      )
    },
    {
      id: 'deepseek',
      title: translate('settings.appearance.search.deepseekTitle', 'DeepSeek Balance'),
      description: translate(
        'settings.appearance.search.deepseekDescription',
        'Show your DeepSeek account balance in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('settings.appearance.search.deepseekKeyword', 'deepseek'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword('settings.appearance.search.balanceKeyword', 'balance'),
        ...translateSearchKeyword('settings.appearance.search.creditsKeyword', 'credits'),
        ...translateSearchKeyword('settings.appearance.search.cnyKeyword', 'cny')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.deepseekToggleDescription',
        'Show DeepSeek account balance in the status bar.'
      )
    },
    {
      id: 'fireworks',
      title: translate('settings.appearance.search.fireworksTitle', 'Fireworks.ai Spend'),
      description: translate(
        'settings.appearance.search.fireworksDescription',
        'Show your Fireworks.ai rated spend in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('settings.appearance.search.fireworksKeyword', 'fireworks'),
        ...translateSearchKeyword('settings.appearance.search.fireworksAiKeyword', 'fireworks.ai'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword('settings.appearance.search.spendKeyword', 'spend'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.edbf0f63a0', 'cost')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.fireworksToggleDescription',
        'Show Fireworks.ai rated spend in the status bar.'
      )
    },
    {
      id: 'copilot',
      title: translate('settings.appearance.search.copilotTitle', 'GitHub Copilot Usage'),
      description: translate(
        'settings.appearance.search.copilotDescription',
        'Show your GitHub Copilot AI credit usage in the status bar.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.appearance.search.896eb53fd4',
          'status bar'
        ),
        ...translateSearchKeyword('settings.appearance.search.copilotKeyword', 'copilot'),
        ...translateSearchKeyword('settings.appearance.search.githubKeyword', 'github'),
        ...translateSearchKeyword('auto.components.settings.appearance.search.00a028f25f', 'usage'),
        ...translateSearchKeyword('settings.appearance.search.aiCreditsKeyword', 'ai credits'),
        ...translateSearchKeyword('settings.appearance.search.tokenKeyword', 'token')
      ],
      toggleDescription: translate(
        'settings.appearance.statusBar.copilotToggleDescription',
        'Show GitHub Copilot AI credit usage in the status bar.'
      )
    },
    getGrokStatusBarToggleSearchEntry()
  ]
}
