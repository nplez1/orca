// The prompt for naming a chat after the user's first request.
//
// Prompt text lives under `src/shared/ai-prompts/`, one module per operation, so the wording can
// be read and changed in one place. `index.ts` lists them and names any still assembled elsewhere.
import {
  MAX_GENERATED_NAME_LENGTH,
  clampConversationNameFirstPrompt,
  type ConversationNameContext
} from '../conversation-name-generation'

/** The naming request's first line; Session History reads it to hide these one-shot runs. */
export const CONVERSATION_NAME_PROMPT_OPENING = "Name this chat from the user's first request."

export function buildConversationNamePrompt(
  context: ConversationNameContext,
  customPrompt = ''
): string {
  const firstPrompt = clampConversationNameFirstPrompt(context.firstPrompt)
  const basePrompt = `${CONVERSATION_NAME_PROMPT_OPENING}
Write a short, specific title of at most ${MAX_GENERATED_NAME_LENGTH} characters.
Output only the title, with no heading, quotes, or explanation.

First request:
${firstPrompt}`
  const extra = customPrompt.trim()
  return extra ? `${basePrompt}\n\nAdditional instructions:\n${extra}` : basePrompt
}
