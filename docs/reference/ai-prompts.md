# AI prompts

Every prompt Orca sends to a model lives under **`src/shared/ai-prompts/`**, one module per
operation, and **`src/shared/ai-prompts/index.ts`** lists them all: id, what the model is asked to
produce, and where the prompt is consumed.

Why one place: a prompt's wording is the thing most likely to be compared and changed by someone
who is not editing the feature around it, and it used to be assembled inside whichever module
called the model — two different commit-message prompts coexisted, one of them dead.

## What is there

| Prompt                | Module                                | Consumed by                              |
| --------------------- | ------------------------------------- | ---------------------------------------- |
| Commit message        | `ai-prompts/commit-message.ts`        | Source Control AI (main/text-generation) |
| Pull request fields   | `ai-prompts/pull-request.ts`          | Source Control AI (main/text-generation) |
| Branch name           | `ai-prompts/branch-name.ts`           | Source Control AI, branch settings       |
| Chat name             | `ai-prompts/conversation-name.ts`     | Session History naming                   |
| Session summary chunk | `ai-prompts/session-summary-chunk.ts` | Session Summary fold                     |

Each module exports its text plus a `buildPrompt(...)` that takes the inputs; the surrounding
module keeps the parsing, bounds and plumbing. `src/shared/session-summary-fold-contract.ts` holds
the event/range types the summary prompt needs, because a shared module may not import from main.

## What is not there yet

`AI_PROMPTS_NOT_YET_CENTRALIZED` in the index names them, so this is a statement about the present
rather than a claim that quietly stopped being true:

- `shared/pr-checks-fix-prompt.ts`, `shared/source-control-conflict-prompts.ts`,
  `shared/source-control-push-failure.ts` — the agent _launch_ prompts behind the fix actions,
  assembled from templates at launch time rather than sent as one completion;
- `shared/jira/jira-issue-summary-generation.ts` — the Jira issue summary;
- `main/runtime/orchestration/preamble.ts` — the dispatched-worker preamble, which describes the
  tool surface as well as the task.

Moving one is mechanical: extract the text and its builder, add a module beside the others, add an
entry to the index, and delete the entry from the list above.

## Rules for changing a prompt

- Change the text in its module, never at a call site.
- Keep the bounds (section caps, timeline caps) next to the prompt they bound.
- A prompt that takes new inputs takes them as arguments to its builder; the builder stays pure so
  it can be asserted in a test.
- If a prompt must differ per caller, that is a signal the operation is two operations.
