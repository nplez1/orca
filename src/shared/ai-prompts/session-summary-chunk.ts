// The prompt for extracting one slice of an agent session transcript.
//
// Every model-facing prompt in Orca lives under `src/shared/ai-prompts/`, one module per
// operation, so the wording can be read and changed in one place. `index.ts` lists them all.
import {
  SESSION_SUMMARY_EVENT_TEXT_MAX_CHARS,
  type SessionSummaryChunkRange,
  type SessionSummarySourceEvent
} from '../session-summary-fold-contract'

export const CHUNK_EXTRACT_INSTRUCTIONS = `You are summarizing a slice of an agent coding session transcript.
Produce a JSON object with exactly these keys:
- "goal": string or null — the objective the agent is working toward, if discernible
- "plan": string[] — steps the agent laid out (at most 5, earliest first)
- "inProgress": string | null — what the agent is doing at the END of this slice
- "done": string[] — completed milestones (at most 5)
- "blockers": string[] — errors, failed approaches, things awaiting input (at most 5)
- "decisions": string[] — notable choices made (at most 5)
- "timeline": array of { "kind": one of "milestone"|"decision"|"error"|"needs-input"|"tool-burst"|"user-input", "text": one short sentence, "sourceIndex": number } — the notable events of this slice, chronological, at most 10. Use the message index shown in the transcript below for "sourceIndex".
Rules: respond with ONLY the JSON object. Use plain lowercase text. If the slice is ambiguous or low-signal, say so in few entries rather than inventing detail.`

function renderChunkTranscript(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  const lines: string[] = []
  for (let index = range.from; index < range.to; index += 1) {
    const event = events[index]
    const text =
      event.text.length > SESSION_SUMMARY_EVENT_TEXT_MAX_CHARS
        ? `${event.text.slice(0, SESSION_SUMMARY_EVENT_TEXT_MAX_CHARS)}…`
        : event.text
    lines.push(`[#${absoluteFrom + index} ${event.role}] ${text}`)
  }
  return lines.join('\n')
}

export function buildSessionSummaryChunkPrompt(
  events: readonly SessionSummarySourceEvent[],
  range: SessionSummaryChunkRange,
  absoluteFrom: number
): string {
  return `${CHUNK_EXTRACT_INSTRUCTIONS}\n\nTranscript slice:\n${renderChunkTranscript(events, range, absoluteFrom)}`
}
