/**
 * Live background work on a Copilot pane.
 *
 * Why one module: a pane's background work spans the lead session AND every subagent it runs — a
 * subagent's async/detached shell outlives the subagent's turn, so it must still hold the pane in
 * monitoring. Copilot reports a shell's completion by the description and `shellId` it started
 * with (not by a correlation token), and `agent_completed`/`SubagentStop` can both report the same
 * subagent. Tracking each item's identity is what stops one completion from consuming an unrelated
 * pending item and settling the pane early.
 */
import { readFirstString } from './interactive-tool'

/** One background shell the pane is still waiting on. */
export type CopilotBackgroundShell = {
  /** `tool_input.description` at start; the completion notification repeats it as `title`. */
  description: string
  /** `shellId` the start's tool result reported, when that event was observed. */
  shellId?: string
}

export type CopilotBackgroundWorkState = {
  pendingShells: CopilotBackgroundShell[]
  pendingUnidentifiedSubagentCount: number
  pendingSubagentLifecycleCount: number
  leadStopped: boolean
}

export function createCopilotBackgroundWorkState(): CopilotBackgroundWorkState {
  return {
    pendingShells: [],
    pendingUnidentifiedSubagentCount: 0,
    pendingSubagentLifecycleCount: 0,
    leadStopped: false
  }
}

export function pendingCopilotBackgroundWork(work: CopilotBackgroundWorkState): number {
  return (
    work.pendingShells.length +
    work.pendingUnidentifiedSubagentCount +
    work.pendingSubagentLifecycleCount
  )
}

export function registerCopilotBackgroundShell(
  work: CopilotBackgroundWorkState,
  shell: CopilotBackgroundShell
): CopilotBackgroundWorkState {
  return { ...work, pendingShells: [...work.pendingShells, shell] }
}

/**
 * Remove the shells a tool result proves are no longer running, by `shellId`. Positive evidence
 * only: an id this pane never registered is ignored rather than consuming a different pending
 * shell and settling the pane early.
 */
export function consumeCopilotBackgroundShells(
  work: CopilotBackgroundWorkState,
  shellIds: readonly string[]
): CopilotBackgroundWorkState {
  let next = work
  for (const shellId of shellIds) {
    const index = next.pendingShells.findIndex((shell) => shell.shellId === shellId)
    if (index === -1) {
      continue
    }
    const pendingShells = [...next.pendingShells]
    pendingShells.splice(index, 1)
    next = { ...next, pendingShells }
  }
  return next
}

/** Consume one outstanding subagent, preferring the lifecycle count a `SubagentStart` already
 *  claimed: `agent_completed` and `SubagentStop` can both report the same agent, and only one may
 *  arrive. Never touches pending shells, so a redundant agent completion cannot settle one. */
export function consumeCopilotSubagent(
  work: CopilotBackgroundWorkState
): CopilotBackgroundWorkState {
  if (work.pendingSubagentLifecycleCount > 0) {
    return { ...work, pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount - 1 }
  }
  return {
    ...work,
    pendingUnidentifiedSubagentCount: Math.max(0, work.pendingUnidentifiedSubagentCount - 1)
  }
}

// ─── How Copilot names a background shell ────────────────────────────────────

/** A start result that actually backgrounded the shell; an async shell that finished within
 *  `initial_wait` returns its output directly and must not be tracked as pending. */
const COPILOT_STARTED_SHELL_RE = /started in (?:detached )?background with shellId:\s*([^\s>)]+)/i
/** A read/stop result that reports a shell no longer running (`<shellId: 0 completed with exit
 *  code 0>`). This is the completion signal when the agent reads a shell instead of waiting for
 *  the `shell_completed` notification, which Copilot then suppresses. */
const COPILOT_TERMINATED_SHELL_RE =
  /shellId:\s*([^\s>)]+)\s+(?:completed|exited|stopped|failed|cancelled)/gi
const COPILOT_SHELL_ID_RE = /shellId:\s*([^)\s>]+)/

/** The shellId a background start's tool result reports, when it really backgrounded the shell. */
export function readStartedShellId(resultText: string | undefined): string | undefined {
  return resultText?.match(COPILOT_STARTED_SHELL_RE)?.[1]?.trim() || undefined
}

/** The shellIds a tool result proves are no longer running. */
export function readTerminatedShellIds(resultText: string | undefined): string[] {
  if (!resultText) {
    return []
  }
  return Array.from(resultText.matchAll(COPILOT_TERMINATED_SHELL_RE), (match) => match[1].trim())
}

/** The shellId a `shell_completed`/`shell_detached_completed` notification names. */
export function readCopilotShellCompletionShellId(
  hookPayload: Record<string, unknown>
): string | undefined {
  const message = readFirstString(hookPayload, ['message', 'body', 'text'])
  return message?.match(COPILOT_SHELL_ID_RE)?.[1]?.trim() || undefined
}
