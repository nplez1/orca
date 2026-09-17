import { z } from 'zod'

/**
 * Consent and retention for the agent-session transcript index.
 *
 * Two tiers share one database:
 *
 * - **Metadata** — one `sessions` row per transcript (agent, session id, path,
 *   cwd, branch, model, times, counts, title, resume command). Always indexed:
 *   it is what Agent Session History lists, and the panel already shows every one
 *   of those values. Its only costs are a stat per transcript and the head of a
 *   transcript that changed.
 * - **Content** — message bodies in `messages` and `messages_fts`, which is what
 *   makes conversations searchable. Off until the user turns it on: this is the
 *   tier that reads every transcript on the machine end to end.
 *
 * There is no `paused`. The indexer is immutable after construction, so every
 * change here is close-and-construct (see session-search-instance.ts).
 */
export type AiVaultSearchSettings = {
  /** Content tier: index message bodies so conversations are searchable. */
  contentEnabled: boolean
  /** null = all history; otherwise only transcripts modified within this many days. */
  historyDays: number | null
}

export const DEFAULT_AI_VAULT_SEARCH_SETTINGS: AiVaultSearchSettings = {
  contentEnabled: false,
  historyDays: null
}

const HISTORY_DAYS_MAX = 3_650

export const AiVaultSearchSettingsSchema: z.ZodType<AiVaultSearchSettings> = z.object({
  contentEnabled: z.boolean(),
  historyDays: z.number().int().positive().max(HISTORY_DAYS_MAX).nullable()
})

export function normalizeAiVaultSearchHistoryDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  // A fractional day floors to 0, which reads as "all history" on one side and
  // "now" on the other; make the two agree.
  const days = Math.floor(value)
  return days <= 0 ? null : Math.min(HISTORY_DAYS_MAX, days)
}

/**
 * The persisted shape, from whatever a settings write or an old profile left behind.
 *
 * The input is `unknown` on purpose: this is the sanitizer, and what it reads is a
 * JSON profile that may predate either field or hold a value no version wrote.
 *
 * `enabled` is the pre-tier name of `contentEnabled`: a profile that recorded
 * consent before the metadata tier existed consented to transcript content, which
 * is the tier that flag now names, so it carries over rather than resetting. An
 * absent flag is no consent.
 */
export function resolveAiVaultSearchSettings(
  settings: { aiVaultSearch?: unknown } | null | undefined
): AiVaultSearchSettings {
  const raw = settings?.aiVaultSearch
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_AI_VAULT_SEARCH_SETTINGS }
  }
  // The current field wins over the pre-tier name when a profile somehow holds
  // both: reading the legacy one first would resurrect a consent the user has
  // since withdrawn.
  const contentEnabled =
    'contentEnabled' in raw ? raw.contentEnabled === true : 'enabled' in raw && raw.enabled === true
  return {
    contentEnabled,
    historyDays: normalizeAiVaultSearchHistoryDays('historyDays' in raw ? raw.historyDays : null)
  }
}

export function sameAiVaultSearchSettings(
  a: AiVaultSearchSettings,
  b: AiVaultSearchSettings
): boolean {
  return a.contentEnabled === b.contentEnabled && a.historyDays === b.historyDays
}
