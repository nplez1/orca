import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../shared/managed-account-types'
import type { CodexConfigSyncStatus } from '../../shared/codex-config-sync-types'
import type { CursorAccountStatus, GrokAccountStatus } from '../../shared/rate-limit-types'
import type { ZcodePlanCredentialsStatus } from '../../shared/zcode-plan-sites'
import type { MiniMaxCredentialsStatus } from '../../shared/minimax-credentials-status'

export type CodexAccountsApi = {
  list: () => Promise<CodexRateLimitAccountsState>
  add: (args?: {
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<CodexRateLimitAccountsState>
  cancelPendingLogin: () => Promise<boolean>
  getPendingLoginUrl: () => Promise<string | null>
  onPendingLoginUrlChanged: (callback: (url: string | null) => void) => () => void
  reauthenticate: (args: {
    accountId: string
    /** Local-only: activate the re-authed account when its runtime lane had no selection. */
    activateIfSelectionWasEmpty?: boolean
  }) => Promise<CodexRateLimitAccountsState>
  remove: (args: { accountId: string }) => Promise<CodexRateLimitAccountsState>
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<CodexRateLimitAccountsState>
  /** Live PTYs whose baked CODEX_HOME still points at a deselected account. */
  listStalePanes: (args: { ptyIds: string[] }) => Promise<
    {
      ptyId: string
      launchAccountId: string | null
      activeAccountId: string | null
    }[]
  >
  /** The selection lane each PTY launched from, keyed by pty id; unrecorded panes are absent. */
  listRecordedPaneLanes: (args: { ptyIds: string[] }) => Promise<Record<string, string>>
  /** Drops launch records so a dismissed prompt stays dismissed across restarts. */
  forgetStalePanes: (args: { ptyIds: string[] }) => Promise<void>
}

export type ClaudeAccountsApi = {
  list: () => Promise<ClaudeRateLimitAccountsState>
  add: (args?: {
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
    /** Copy the sign-in link instead of opening the default browser. */
    copyLink?: boolean
  }) => Promise<ClaudeRateLimitAccountsState>
  cancelPendingLogin: () => Promise<boolean>
  reauthenticate: (args: {
    accountId: string
    copyLink?: boolean
  }) => Promise<ClaudeRateLimitAccountsState>
  /** The pending sign-in's link once Claude hands it over; null if it ends without one. */
  waitForSignInLink: () => Promise<string | null>
  remove: (args: { accountId: string }) => Promise<ClaudeRateLimitAccountsState>
  select: (args: {
    accountId: string | null
    runtime?: 'host' | 'wsl'
    wslDistro?: string | null
  }) => Promise<ClaudeRateLimitAccountsState>
}

export type GrokAccountsApi = {
  getStatus: () => Promise<GrokAccountStatus>
}

export type CursorAccountsApi = {
  getStatus: () => Promise<CursorAccountStatus>
}

export type MinimaxCredentialsApi = {
  // configured remains cookie OR API key for existing callers.
  getStatus: () => Promise<MiniMaxCredentialsStatus>
  saveCookie: (cookie: string) => Promise<MiniMaxCredentialsStatus>
  clearCookie: () => Promise<MiniMaxCredentialsStatus>
  saveApiKey: (key: string) => Promise<MiniMaxCredentialsStatus>
  clearApiKey: () => Promise<MiniMaxCredentialsStatus>
}

export type ZcodePlanCredentialsApi = {
  // Report presence of the saved key and read-only CLI credentials without exposing either value.
  getStatus: () => Promise<ZcodePlanCredentialsStatus>
  saveApiKey: (key: string) => Promise<ZcodePlanCredentialsStatus>
  clearApiKey: () => Promise<ZcodePlanCredentialsStatus>
}

export type DeepSeekCredentialsApi = {
  // Why: the key lives in main's encrypted store, so the renderer only ever
  // learns whether one is present.
  getStatus: () => Promise<{ configured: boolean; apiKeyConfigured: boolean }>
  saveApiKey: (key: string) => Promise<{ apiKeyConfigured: boolean }>
  clearApiKey: () => Promise<{ apiKeyConfigured: boolean }>
}

export type DeepInfraCredentialsApi = {
  getStatus: () => Promise<{ configured: boolean; apiKeyConfigured: boolean }>
  saveApiKey: (key: string) => Promise<{ apiKeyConfigured: boolean }>
  clearApiKey: () => Promise<{ apiKeyConfigured: boolean }>
}

export type FireworksCredentialsApi = {
  // Why: the API key and the optional account-ID override share one encrypted
  // file, so a single status call seeds both form fields.
  getStatus: () => Promise<{
    configured: boolean
    apiKeyConfigured: boolean
    accountIdOverride: string | null
  }>
  save: (
    apiKey: string,
    accountIdOverride: string | null
  ) => Promise<{ apiKeyConfigured: boolean; accountIdOverride: string | null }>
  clear: () => Promise<{ apiKeyConfigured: boolean }>
}

export type CopilotCredentialsApi = {
  // Why: the token and the enterprise slug share one encrypted file, so a single
  // status call seeds the slug field; the token itself never reaches the renderer.
  // `source` reports whether those credentials came from the store or from the
  // user's GitHub CLI sign-in, and `ghSetupHint` carries the command that would make
  // the CLI usable when that is the blocker.
  getStatus: () => Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }>
  save: (
    token: string,
    enterpriseSlug: string
  ) => Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }>
  clear: () => Promise<{
    configured: boolean
    enterpriseSlug: string | null
    source: 'stored' | 'github-cli' | 'none'
    ghSetupHint: string | null
  }>
}

export type CodexConfigSyncApi = {
  status: () => Promise<CodexConfigSyncStatus>
}
