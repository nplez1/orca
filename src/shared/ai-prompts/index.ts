// Every model-facing prompt in Orca, in one list.
//
// Why this file exists: the wording of a prompt is the thing most likely to be read, compared
// and changed by someone who is not editing the feature around it, and it used to be assembled
// inside whichever module called the model. Each prompt is one module beside this one; this is
// the index that makes them findable, and the place to look when asking "what does Orca tell a
// model, and where does it say it?".
//
// Adding a prompt means adding a module here and an entry below. A prompt that lives anywhere
// else is a bug against this list.
import type { BranchNameWorkContext } from '../branch-name-from-work'
import type { CommitMessageDraftContext } from '../commit-message-generation'
import type { ConversationNameContext } from '../conversation-name-generation'
import type {
  SessionSummaryChunkRange,
  SessionSummarySourceEvent
} from '../session-summary-fold-contract'
import type { PullRequestDraftContext } from '../pull-request-generation'
import { buildBranchNamePrompt } from './branch-name'
import { buildCommitMessagePrompt } from './commit-message'
import { buildConversationNamePrompt } from './conversation-name'
import { buildPullRequestFieldsPrompt } from './pull-request'
import { buildSessionSummaryChunkPrompt } from './session-summary-chunk'

/**
 * One prompt: what it is for, and how to build it from its inputs.
 *
 * The builders keep their own signatures — a record that erased them to `unknown` would compile
 * and then lie about every call site — so this list is for discovery and for the shape it
 * documents, not for dispatching.
 */
export type AiPromptEntry = {
  id: string
  /** One line: what the model is being asked to produce. */
  purpose: string
  /** Where the prompt is consumed, for the reader who wants the surrounding flow. */
  usedBy: string
  buildPrompt: (...args: never[]) => string
}

export const AI_PROMPTS: readonly AiPromptEntry[] = [
  {
    id: 'commit-message',
    purpose: 'A single git commit message from the staged diff.',
    usedBy: 'Source Control AI → commit message (main/text-generation)',
    buildPrompt: (context: CommitMessageDraftContext, customPrompt: string) =>
      buildCommitMessagePrompt(context, customPrompt)
  },
  {
    id: 'pull-request-fields',
    purpose: 'A pull request base, title, body and draft flag, as compact JSON.',
    usedBy: 'Source Control AI → pull request details (main/text-generation)',
    buildPrompt: (context: PullRequestDraftContext, customPrompt: string) =>
      buildPullRequestFieldsPrompt(context, customPrompt)
  },
  {
    id: 'branch-name',
    purpose: 'A short branch name for the work in front of the user.',
    usedBy: 'Source Control AI → branch name (main/text-generation)',
    buildPrompt: (context: BranchNameWorkContext, customPrompt: string) =>
      buildBranchNamePrompt(context, customPrompt)
  },
  {
    id: 'conversation-name',
    purpose: "A short chat title from the user's first request.",
    usedBy: 'Session History chat naming (main/text-generation)',
    buildPrompt: (context: ConversationNameContext, customPrompt: string) =>
      buildConversationNamePrompt(context, customPrompt)
  },
  {
    id: 'session-summary-chunk',
    purpose:
      'A structured extract (goal, plan, done, blockers, timeline) from one slice of a session transcript.',
    usedBy: 'Session Summary fold (main/session-summary)',
    buildPrompt: (
      events: readonly SessionSummarySourceEvent[],
      range: SessionSummaryChunkRange,
      absoluteFrom: number
    ) => buildSessionSummaryChunkPrompt(events, range, absoluteFrom)
  }
] as const

/**
 * Prompts that are still assembled where they are consumed.
 *
 * Kept as a list rather than left implicit, so "one place" is a statement about the present
 * state and not a claim that quietly stopped being true. Moving each one is mechanical: extract
 * the text and its builder, add a module beside this file, add an entry above.
 *
 * - `shared/pr-checks-fix-prompt.ts`, `shared/source-control-conflict-prompts.ts`,
 *   `shared/source-control-push-failure.ts` — the agent *launch* prompts behind the fix actions.
 *   They are assembled from templates at launch time rather than sent as one completion.
 * - `shared/jira/jira-issue-summary-generation.ts` — the Jira issue summary, text generation with
 *   a provider-specific template.
 * - `main/runtime/orchestration/preamble.ts` — the dispatched-worker preamble, which describes
 *   the tool surface as well as the task.
 */
export const AI_PROMPTS_NOT_YET_CENTRALIZED: readonly string[] = [
  'shared/pr-checks-fix-prompt.ts',
  'shared/source-control-conflict-prompts.ts',
  'shared/source-control-push-failure.ts',
  'shared/jira/jira-issue-summary-generation.ts',
  'main/runtime/orchestration/preamble.ts'
]
