import type { ReactNode } from 'react'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { ZCODE_PLAN_SITE_CONSOLE_URLS } from '../../../../shared/zcode-plan-sites'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  ClaudeIcon,
  GeminiIcon,
  MiniMaxIcon,
  OpenAIIcon,
  OpenCodeGoIcon
} from '../status-bar/icons'
import { CopilotIcon, DeepSeekIcon, FireworksIcon } from '../status-bar/fork-usage-providers'
import type { SettingsSearchEntry } from './settings-search'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import type { ProviderAccountsIcon } from './ProviderAccountsSection'
import { ProviderHeaderLink } from './ProviderAccountsSection'
import {
  getAccountsAntigravitySearchEntries,
  getAccountsCodexSearchEntries,
  getAccountsCopilotSearchEntries,
  getAccountsCursorSearchEntries,
  getAccountsDeepSeekSearchEntries,
  getAccountsFireworksSearchEntries,
  getAccountsGeminiSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsKimiSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsOpencodeSearchEntries,
  getAccountsZcodePlanSearchEntries
} from './accounts-search'
import { getAccountsClaudeSearchEntries } from './accounts-claude-search'
import type { UsageCredentialHost } from './usage-credential-host'
import type { UsageHostSettingsModel } from './use-usage-host-settings'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import { renderCodexAccountsSection } from './accounts-pane-codex-section'
import {
  renderGeminiAccountsSection,
  renderOpenCodeAccountsSection
} from './accounts-pane-provider-setting-sections'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'
import { MiniMaxAccountsSection, getMiniMaxConsoleUrl } from './MiniMaxAccountsSection'
import { renderDeepSeekAccountsSection } from './accounts-pane-deepseek-section'
import { renderFireworksAccountsSection } from './accounts-pane-fireworks-section'
import { renderCopilotAccountsSection } from './accounts-pane-copilot-section'
import { GrokAccountsSection } from './GrokAccountsSection'
import { CursorAccountsSection } from './CursorAccountsSection'
import { ZcodePlanAccountsSection, resolveZcodePlanSite } from './ZcodePlanAccountsSection'

export type ProviderAccountsSectionContext = {
  model: AccountsPaneSectionModel
  accountOwner: RuntimeClientTarget
  accountOwnerKey: string
  accountOwnerPlatform: NodeJS.Platform | null
  usageCredentialHost: UsageCredentialHost
  usageHostSettings: UsageHostSettingsModel
}

/**
 * One entry per provider in AI Provider Accounts. The pane walks this list instead
 * of enumerating sections by hand, so the header, the usage switch and the
 * search-filtered mount arrive together: a provider cannot be added here without
 * getting a switch, and `provider-account-sections.test.ts` holds this list and
 * `USAGE_PROVIDER_IDS` to the same set.
 */
export type ProviderAccountsSectionEntry = {
  id: DisableableUsageProviderId
  /** The provider's display name; also the off notice's subject and the switch label. */
  title: string
  description: string | ((context: ProviderAccountsSectionContext) => string)
  Icon: ProviderAccountsIcon
  searchEntries: () => SettingsSearchEntry[]
  headerAction?: (context: ProviderAccountsSectionContext) => ReactNode
  /** Omitted only where the provider has nothing to configure in this pane. */
  renderBody?: (context: ProviderAccountsSectionContext) => ReactNode
}

const DEEPSEEK_CONSOLE_URL = 'https://platform.deepseek.com/usage'
const FIREWORKS_CONSOLE_URL = 'https://app.fireworks.ai/settings/users/api-keys'
const COPILOT_TOKENS_URL = 'https://github.com/settings/tokens?type=beta'
const GROK_CLI_DOCS_URL = 'https://docs.x.ai/build/overview'
const CURSOR_USAGE_DASHBOARD_URL = 'https://cursor.com/dashboard/spending'

const KimiIcon: ProviderAccountsIcon = ({ size }) => <AgentIcon agent="kimi" size={size} />
const GrokIcon: ProviderAccountsIcon = ({ size }) => <AgentIcon agent="grok" size={size} />
const CursorIcon: ProviderAccountsIcon = ({ size }) => <AgentIcon agent="cursor" size={size} />
const AntigravityIcon: ProviderAccountsIcon = ({ size }) => (
  <AgentIcon agent="antigravity" size={size} />
)
const ZcodeIcon: ProviderAccountsIcon = ({ size }) => <AgentIcon agent="zcode" size={size} />

export const PROVIDER_ACCOUNTS_SECTIONS: readonly ProviderAccountsSectionEntry[] = [
  {
    id: 'claude',
    title: translate('auto.components.settings.AccountsPane.26ef4b55be', 'Claude'),
    description: translate(
      'auto.components.settings.AccountsPane.72b36ea174',
      'Optional. Orca can use your normal Claude login; add accounts only if you want quick switching without moving chat sessions.'
    ),
    Icon: ClaudeIcon,
    searchEntries: getAccountsClaudeSearchEntries,
    renderBody: ({ model }) => renderClaudeAccountsSection(model)
  },
  {
    id: 'codex',
    title: translate('auto.components.settings.AccountsPane.ef91cfa06b', 'Codex'),
    description: translate(
      'auto.components.settings.AccountsPane.cedfab35ab',
      'Optional. Orca can use your normal Codex login; add accounts only if you want quick switching in Orca.'
    ),
    Icon: OpenAIIcon,
    searchEntries: getAccountsCodexSearchEntries,
    renderBody: ({ model }) => renderCodexAccountsSection(model)
  },
  {
    id: 'gemini',
    title: translate('auto.components.settings.AccountsPane.aa4de4475b', 'Gemini CLI (legacy)'),
    description: translate(
      'auto.components.settings.AccountsPane.973741a871',
      'Keep existing Gemini CLI sessions available. Gemini credentials do not sign you into Antigravity.'
    ),
    Icon: GeminiIcon,
    searchEntries: getAccountsGeminiSearchEntries,
    renderBody: ({ model }) => renderGeminiAccountsSection(model)
  },
  {
    id: 'antigravity',
    title: translate('accounts.antigravity.title', 'Antigravity'),
    description: ({ model }) =>
      translate('accounts.antigravity.scope', 'Manage the native agy account on {{host}}.', {
        host: model.accountRuntimeSentenceLabel
      }),
    Icon: AntigravityIcon,
    searchEntries: getAccountsAntigravitySearchEntries,
    renderBody: ({ model, accountOwner, accountOwnerKey, accountOwnerPlatform }) => (
      <AntigravityAccountsSection
        key={`antigravity:${accountOwnerKey}:${model.accountRuntime.runtime}:${model.accountRuntime.wslDistro ?? ''}`}
        owner={accountOwner}
        target={{
          runtime: model.accountRuntime.runtime,
          wslDistro: model.accountRuntime.wslDistro
        }}
        label={model.accountRuntimeSentenceLabel}
        ownerPlatform={accountOwnerPlatform}
      />
    )
  },
  {
    id: 'opencode-go',
    title: translate('auto.components.settings.AccountsPane.4ac10b4d08', 'OpenCode Go'),
    description: translate(
      'auto.components.settings.AccountsPane.ea631977b5',
      'Configure OpenCode Go provider settings.'
    ),
    Icon: OpenCodeGoIcon,
    searchEntries: getAccountsOpencodeSearchEntries,
    renderBody: ({ model }) => renderOpenCodeAccountsSection(model)
  },
  {
    id: 'kimi',
    title: translate('auto.components.settings.ProviderAccountsSection.kimiTitle', 'Kimi'),
    // Why: Kimi has no pane credentials — its sign-in lives in Kimi Code's own home.
    description: translate(
      'auto.components.settings.ProviderAccountsSection.kimiDescription',
      'Usage comes from the Kimi Code sign-in already on this computer; there is nothing to set up here.'
    ),
    Icon: KimiIcon,
    searchEntries: getAccountsKimiSearchEntries
  },
  {
    id: 'minimax',
    title: translate('auto.components.settings.AccountsPane.5d63bbfbec', 'MiniMax'),
    description: translate(
      'auto.components.settings.AccountsPane.usageTracking',
      'Configure MiniMax usage tracking for your account.'
    ),
    Icon: MiniMaxIcon,
    searchEntries: getAccountsMiniMaxSearchEntries,
    headerAction: ({ usageHostSettings }) => (
      <ProviderHeaderLink
        href={getMiniMaxConsoleUrl(usageHostSettings.settings)}
        label={translate('auto.components.settings.AccountsPane.0d8e77bc40', 'Open console')}
      />
    ),
    renderBody: ({ model, accountOwnerKey, usageCredentialHost, usageHostSettings }) => (
      <MiniMaxAccountsSection
        key={`minimax:${accountOwnerKey}`}
        host={usageCredentialHost}
        usageSettings={usageHostSettings}
        miniMaxRateLimits={model.isRemoteAccountScope ? null : model.miniMaxRateLimits}
        recordFeatureInteraction={model.recordFeatureInteraction}
      />
    )
  },
  {
    id: 'deepseek',
    title: translate(
      'auto.components.settings.accounts.pane.deepseek.section.28c8b91c5d',
      'DeepSeek'
    ),
    description: translate(
      'auto.components.settings.accounts.pane.deepseek.section.53ce175669',
      'Configure DeepSeek usage tracking for your account.'
    ),
    Icon: DeepSeekIcon,
    searchEntries: getAccountsDeepSeekSearchEntries,
    headerAction: () => (
      <ProviderHeaderLink
        href={DEEPSEEK_CONSOLE_URL}
        label={translate(
          'auto.components.settings.accounts.pane.deepseek.section.47e631f32d',
          'Open console'
        )}
      />
    ),
    renderBody: ({ model }) => renderDeepSeekAccountsSection(model)
  },
  {
    id: 'fireworks',
    title: translate(
      'auto.components.settings.accounts.pane.fireworks.section.51bcc16ae3',
      'Fireworks.ai'
    ),
    description: translate(
      'auto.components.settings.accounts.pane.fireworks.section.5f31aaba69',
      'Configure Fireworks.ai usage tracking for your account.'
    ),
    Icon: FireworksIcon,
    searchEntries: getAccountsFireworksSearchEntries,
    headerAction: () => (
      <ProviderHeaderLink
        href={FIREWORKS_CONSOLE_URL}
        label={translate(
          'auto.components.settings.accounts.pane.fireworks.section.d8c675f9f0',
          'Open console'
        )}
      />
    ),
    renderBody: ({ model }) => renderFireworksAccountsSection(model)
  },
  {
    id: 'copilot',
    title: translate(
      'auto.components.settings.accounts.pane.copilot.section.dc3eaf8d70',
      'GitHub Copilot'
    ),
    description: translate(
      'auto.components.settings.accounts.pane.copilot.section.ed307672cd',
      'Configure GitHub Copilot usage tracking for your account.'
    ),
    Icon: CopilotIcon,
    searchEntries: getAccountsCopilotSearchEntries,
    headerAction: () => (
      <ProviderHeaderLink
        href={COPILOT_TOKENS_URL}
        label={translate(
          'auto.components.settings.accounts.pane.copilot.section.f8bb20c24c',
          'Open console'
        )}
      />
    ),
    renderBody: ({ model }) => renderCopilotAccountsSection(model)
  },
  {
    id: 'grok',
    title: translate('auto.components.settings.GrokAccountsSection.a1b2c3d4e5', 'Grok (xAI)'),
    description: translate(
      'auto.components.settings.GrokAccountsSection.f6e5d4c3b2',
      'Shows weekly credit usage from your Grok CLI sign-in (session file ~/.grok/auth.json).'
    ),
    Icon: GrokIcon,
    searchEntries: getAccountsGrokSearchEntries,
    headerAction: () => (
      <ProviderHeaderLink
        href={GROK_CLI_DOCS_URL}
        label={translate(
          'auto.components.settings.GrokAccountsSection.0d8e77bc40',
          'Grok CLI docs'
        )}
      />
    ),
    renderBody: () => <GrokAccountsSection key="grok" />
  },
  {
    id: 'cursor',
    title: translate('auto.components.settings.CursorAccountsSection.title', 'Cursor'),
    description: translate(
      'auto.components.settings.CursorAccountsSection.subtitle',
      'Shows your Cursor plan usage from the sign-in already on this computer. Orca only reads it — it never changes your Cursor login.'
    ),
    Icon: CursorIcon,
    searchEntries: getAccountsCursorSearchEntries,
    headerAction: () => (
      <ProviderHeaderLink
        href={CURSOR_USAGE_DASHBOARD_URL}
        label={translate(
          'auto.components.settings.CursorAccountsSection.dashboardLink',
          'Cursor dashboard'
        )}
      />
    ),
    renderBody: () => <CursorAccountsSection key="cursor" />
  },
  {
    id: 'zcode',
    title: translate('auto.components.settings.ZcodePlanAccountsSection.title', 'GLM Coding Plan'),
    description: translate(
      'auto.components.settings.ZcodePlanAccountsSection.subtitle',
      'Track Z.AI or Zhipu (BigModel) GLM Coding Plan usage in the status bar. Save the plan API key here — no ZCode CLI setup needed.'
    ),
    Icon: ZcodeIcon,
    searchEntries: getAccountsZcodePlanSearchEntries,
    headerAction: ({ usageCredentialHost, usageHostSettings }) => {
      const site = resolveZcodePlanSite(usageHostSettings, usageCredentialHost)
      return site ? (
        <ProviderHeaderLink
          href={ZCODE_PLAN_SITE_CONSOLE_URLS[site]}
          label={translate(
            'auto.components.settings.ZcodePlanAccountsSection.consoleLink',
            'Get API key'
          )}
        />
      ) : null
    },
    renderBody: ({ accountOwnerKey, usageCredentialHost, usageHostSettings }) => (
      <ZcodePlanAccountsSection
        key={`zcode:${accountOwnerKey}`}
        host={usageCredentialHost}
        usageSettings={usageHostSettings}
      />
    )
  }
]
