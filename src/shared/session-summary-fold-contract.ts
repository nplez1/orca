// The shape a session-summary fold reads from: the events, the slices, and the per-event cap.
//
// Shared rather than main-side because the prompt that renders a slice lives in
// `src/shared/ai-prompts/` with every other model-facing prompt, and a shared module may not
// import from main.

/** The cap a single transcript event contributes to a prompt. */
export const SESSION_SUMMARY_EVENT_TEXT_MAX_CHARS = 1_500

export type SessionSummarySourceEvent = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestamp: string | null
}

export type SessionSummaryChunkRange = { from: number; to: number }
