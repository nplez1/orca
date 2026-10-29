import type { ScreenPromptObservation } from '../../../shared/agent-screen-prompt'
import { AgentHookServerStatusApplication } from './server-status-application'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { ScreenPromptCorroboration } from './server-screen-prompt-corroboration'

type ScreenPromptReader = (
  paneKey: string,
  agentType: string | undefined
) => ScreenPromptObservation | null | undefined

type ScreenPromptForgetter = (paneKey: string) => void

/** Switch point for both pane-owning hosts (main and orcad): the screen is the only witness of a
 *  dialog some agents' hooks cannot report, and only the host can read a pane's terminal. */
export function wireScreenPromptReader(
  server: Pick<
    AgentHookServerScreenPromptWiring,
    'setScreenPromptReader' | 'setScreenPromptForgetter'
  >,
  runtime: {
    readPaneScreenPrompt: ScreenPromptReader
    forgetPaneScreenPrompt: ScreenPromptForgetter
  }
): void {
  server.setScreenPromptReader((paneKey, agentType) =>
    runtime.readPaneScreenPrompt(paneKey, agentType)
  )
  // Why required: a reader that keeps a per-pane stamp with no forgetter reverts to the stale-clock
  // bug this binding exists to fix, and nothing would report it.
  server.setScreenPromptForgetter((paneKey) => runtime.forgetPaneScreenPrompt(paneKey))
}

/**
 * Lets the pane's screen settle a row whose agent cannot report its own dialogs: Copilot's
 * `permission_prompt` also fires for requests its CLI approves itself, so no hook proves a dialog,
 * and pi's own dialog events are only as durable as its silence between them.
 * Split out of the status-update chain to keep that file inside its line budget.
 */
export abstract class AgentHookServerScreenPromptWiring extends AgentHookServerStatusApplication {
  /** Bound by the host that owns panes (main, or the runtime behind `orca serve`); absent in the
   *  relay's parser, which has no screen to read. */
  private screenPromptReader: ScreenPromptReader | null = null
  private screenPromptForgetter: ScreenPromptForgetter | null = null

  private readonly screenPromptCorroboration = new ScreenPromptCorroboration({
    readsScreen: () => this.screenPromptReader !== null,
    readScreenPrompt: (paneKey, agentType) => this.screenPromptReader?.(paneKey, agentType),
    forgetScreenPrompt: (paneKey) => this.screenPromptForgetter?.(paneKey),
    currentRow: (paneKey) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main stores enriched rows; this shared view only declares their base event type.
      this.state.lastStatusByPaneKey.get(paneKey) as EnrichedAgentHookEventPayload | undefined,
    // Why osc: a screen read repaints what the pane already showed, and the observation states that
    // ('snapshot'), while any later OSC or OSC 7501 row is free to overwrite it.
    publishScreenPromptRow: (row) => this.applyNormalizedStatus(row, undefined, 'osc')?.receivedAt
  })

  /** Binds the pane-side screen reader; null leaves every screen claim unread. */
  setScreenPromptReader(reader: ScreenPromptReader | null): void {
    this.screenPromptReader = reader
    // Why here: a headless host starts the store before it has a runtime to read panes with, so the
    // rows hydrated in between would otherwise never be adopted.
    this.adoptHydratedScreenPromptRows()
  }

  /** Binds the pane-side stamp withdrawal; null leaves every stamp to the screen's own read. */
  setScreenPromptForgetter(forgetter: ScreenPromptForgetter | null): void {
    this.screenPromptForgetter = forgetter
  }

  /** The pane's screen gained a dialog: earlier and surer evidence than any deferred read. */
  noteScreenPromptGained(paneKey: string): void {
    if (!this.server) {
      return
    }
    this.screenPromptCorroboration.noteDialogGained(paneKey)
  }

  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    // Why here: every stored row passes through, including the hook that precedes a dialog.
    if (after && this.server) {
      this.screenPromptCorroboration.arm(after)
    }
    return super.commitStatusRowMutation(before, after, emit)
  }

  /** Stops every pending read; a stopped server must not publish into the next one's store. */
  protected clearScreenPromptReads(): void {
    this.screenPromptCorroboration.clearAll()
  }

  /** Arms the wait rows the store hydrated before any listener existed: they come back with no
   *  loop behind them, and no hook is coming to end a wait whose dialog closed while Orca was away. */
  protected adoptHydratedScreenPromptRows(): void {
    if (!this.server || !this.screenPromptReader) {
      return
    }
    for (const stored of this.state.lastStatusByPaneKey.values()) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main stores enriched rows; this shared view only declares their base event type.
      const row = stored as EnrichedAgentHookEventPayload
      if (row.hookEventName === 'screen_prompt' && row.connectionId === null) {
        this.screenPromptCorroboration.arm(row)
      }
    }
  }
}
