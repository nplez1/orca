import type { CommitMessageAiSettings } from './commit-message-ai-types'

/**
 * Agent, model, and thinking level for the session-summary fold.
 *
 * Same shape as the commit-message settings minus the two fields this feature has
 * no use for: there is nothing to enable (a fold only runs while its pane is on
 * screen) and the fold writes its own extraction prompt. Storage is separate so a
 * summary never silently inherits the commit-message choice.
 */
export type SessionSummaryAiSettings = Omit<CommitMessageAiSettings, 'enabled' | 'customPrompt'>
