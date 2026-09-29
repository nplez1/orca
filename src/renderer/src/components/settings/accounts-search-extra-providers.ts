import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

/**
 * Search entries for the newer usage providers.
 *
 * Why its own module: extracted from `accounts-search.ts` to keep that file under the max-lines
 * budget. Re-exported from there so the public API is unchanged.
 */

export const getAccountsGrokSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.f4a8c2e1b7', 'Grok (xAI) Usage'),
    description: translate(
      'auto.components.settings.accounts.search.e3b7d1f9a2',
      'OAuth sign-in via Grok CLI (grok login) for weekly credit usage.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.d2c6a0e8f1', 'grok'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c1b5f9d7e0', 'xai'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.b0a4e8c6d9', 'oauth'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.a9f3d7b5c8', 'login'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.e949b08ffb',
        'rate limit'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  }
])

export const getAccountsCursorSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.cursor.title', 'Cursor Usage'),
    description: translate(
      'auto.components.settings.accounts.search.cursor.description',
      'Monthly plan usage read from the Cursor sign-in already on this computer (cursor-agent login).'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.cursor',
        'cursor'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.spend',
        'spend'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.rateLimit',
        'rate limit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.statusBar',
        'status bar'
      )
    ]
  }
])

export const getAccountsAntigravitySearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('accounts.antigravity.searchTitle', 'Antigravity Accounts'),
    description: translate(
      'accounts.antigravity.searchDescription',
      'Save and select native agy Google accounts on the execution host.'
    ),
    keywords: [
      ...translateSearchKeyword('accounts.antigravity.keyword.antigravity', 'antigravity'),
      ...translateSearchKeyword('accounts.antigravity.keyword.agy', 'agy'),
      ...translateSearchKeyword('accounts.antigravity.keyword.google', 'google'),
      ...translateSearchKeyword('accounts.antigravity.keyword.accounts', 'accounts'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.a9f3d7b5c8', 'login'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.cursor.kw.usage', 'usage')
    ]
  }
])

export const getAccountsZcodePlanSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.zcodePlan.title', 'GLM Coding Plan'),
    description: translate(
      'auto.components.settings.accounts.search.zcodePlan.description',
      'Track Z.AI or Zhipu (BigModel) GLM Coding Plan usage. Pick the site and save the plan API key.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.accounts.search.zcodePlan.kw.glm', 'glm'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.zcodePlan.kw.zai', 'zai'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.zcodePlan.kw.zhipu',
        'zhipu'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.zcodePlan.kw.bigmodel',
        'bigmodel'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.zcodePlan.kw.codingPlan',
        'coding plan'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.zcodePlan.kw.rateLimit',
        'rate limit'
      )
    ]
  }
])
