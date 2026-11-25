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

/** One background agent running a turn, known by the `agent_id` its launch result reported. An
 *  agent that went idle (waiting for `write_agent`) or completed leaves the roster. */
export type CopilotBackgroundAgent = {
  agentId: string
  /** Its id-less `SubagentStart` has not arrived yet, so the next one belongs to it. */
  awaitingStart: boolean
}

export type CopilotBackgroundWorkState = {
  pendingShells: CopilotBackgroundShell[]
  pendingUnidentifiedSubagentCount: number
  pendingSubagentLifecycleCount: number
  backgroundAgents: CopilotBackgroundAgent[]
  leadStopped: boolean
}

export function createCopilotBackgroundWorkState(): CopilotBackgroundWorkState {
  return {
    pendingShells: [],
    pendingUnidentifiedSubagentCount: 0,
    pendingSubagentLifecycleCount: 0,
    backgroundAgents: [],
    leadStopped: false
  }
}

export function pendingCopilotBackgroundWork(work: CopilotBackgroundWorkState): number {
  return (
    work.pendingShells.length +
    work.pendingUnidentifiedSubagentCount +
    work.pendingSubagentLifecycleCount +
    work.backgroundAgents.length
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
 *  claimed. Never touches pending shells, so a redundant agent completion cannot settle one; only
 *  an id-less `agent_completed` may also end a rostered agent, since nothing else would. */
export function consumeCopilotSubagent(
  work: CopilotBackgroundWorkState,
  roster: { endedAgentIds: Set<string> } | undefined
): CopilotBackgroundWorkState {
  if (work.pendingSubagentLifecycleCount > 0) {
    return { ...work, pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount - 1 }
  }
  if (work.pendingUnidentifiedSubagentCount > 0 || !roster || work.backgroundAgents.length === 0) {
    return {
      ...work,
      pendingUnidentifiedSubagentCount: Math.max(0, work.pendingUnidentifiedSubagentCount - 1)
    }
  }
  roster.endedAgentIds.add(work.backgroundAgents[0].agentId)
  return { ...work, backgroundAgents: work.backgroundAgents.slice(1) }
}

function addAgent(
  work: CopilotBackgroundWorkState,
  agentId: string,
  awaitingStart: boolean
): CopilotBackgroundWorkState {
  return { ...work, backgroundAgents: [...work.backgroundAgents, { agentId, awaitingStart }] }
}

function hasAgent(work: CopilotBackgroundWorkState, agentId: string): boolean {
  return work.backgroundAgents.some((agent) => agent.agentId === agentId)
}

/** A launch result named this background agent: it takes over the anonymous entry its launch or
 *  `SubagentStart` counted, so later ends are matched to it by id. A known or ended id is a no-op:
 *  only `write_agent` re-opens an agent, so a replayed or quoted launch cannot hold the pane. */
export function registerCopilotBackgroundAgent(
  work: CopilotBackgroundWorkState,
  agentId: string,
  endedAgentIds: ReadonlySet<string>
): CopilotBackgroundWorkState {
  if (hasAgent(work, agentId) || endedAgentIds.has(agentId)) {
    return work
  }
  if (work.pendingUnidentifiedSubagentCount > 0) {
    const next = {
      ...work,
      pendingUnidentifiedSubagentCount: work.pendingUnidentifiedSubagentCount - 1
    }
    return addAgent(next, agentId, true)
  }
  if (work.pendingSubagentLifecycleCount > 0) {
    const next = { ...work, pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount - 1 }
    return addAgent(next, agentId, false)
  }
  return addAgent(work, agentId, true)
}

/** `write_agent` starts an idle agent's next turn (or steers a running one). */
export function reengageCopilotBackgroundAgents(
  work: CopilotBackgroundWorkState,
  agentIds: readonly string[],
  endedAgentIds: Set<string>
): CopilotBackgroundWorkState {
  let next = work
  for (const agentId of agentIds) {
    endedAgentIds.delete(agentId)
    next = hasAgent(next, agentId) ? next : addAgent(next, agentId, true)
  }
  return next
}

/** `SubagentStart` carries no agent id; it belongs to a rostered agent still awaiting it, else it
 *  claims an anonymous launch (or a launch this pane never saw). */
export function startCopilotSubagent(work: CopilotBackgroundWorkState): CopilotBackgroundWorkState {
  const index = work.backgroundAgents.findIndex((agent) => agent.awaitingStart)
  if (index !== -1) {
    const backgroundAgents = [...work.backgroundAgents]
    backgroundAgents[index] = { ...backgroundAgents[index], awaitingStart: false }
    return { ...work, backgroundAgents }
  }
  return {
    ...work,
    pendingUnidentifiedSubagentCount: Math.max(0, work.pendingUnidentifiedSubagentCount - 1),
    pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount + 1
  }
}

/** What an end that names no rostered agent may consume instead: anonymous counts, anonymous
 *  counts or the roster, or nothing. */
export type CopilotSubagentEndFallback = 'counts' | 'counts-or-roster' | 'none'

/**
 * End one agent's turn. Idle and completed both leave nothing running. The id is remembered
 * (until the pane's next `SessionStart`) so a second report for the same turn is a no-op instead
 * of consuming a different agent — `SubagentStop` and `agent_idle`/`agent_completed` often both
 * arrive, and the pane's work state is dropped once nothing is pending.
 */
export function endCopilotSubagent(
  work: CopilotBackgroundWorkState,
  agentId: string | undefined,
  endedAgentIds: Set<string>,
  fallback: CopilotSubagentEndFallback
): CopilotBackgroundWorkState {
  if (agentId !== undefined && hasAgent(work, agentId)) {
    endedAgentIds.add(agentId)
    return {
      ...work,
      backgroundAgents: work.backgroundAgents.filter((agent) => agent.agentId !== agentId)
    }
  }
  if ((agentId !== undefined && endedAgentIds.has(agentId)) || fallback === 'none') {
    return work
  }
  if (agentId !== undefined) {
    endedAgentIds.add(agentId)
  }
  return consumeCopilotSubagent(
    work,
    fallback === 'counts-or-roster' ? { endedAgentIds } : undefined
  )
}

// ─── How Copilot names a background agent ────────────────────────────────────

/** The launch result itself (`Agent started in background with agent_id: <id>. …`), anchored so
 *  a transcript or file that merely quotes the phrase does not register an agent. */
const COPILOT_BACKGROUND_AGENT_RE =
  /^\s*Agent started in background with agent_id:\s*([\w.-]*[\w-])/
/** An agent notification's `Use read_agent with agent_id "<id>" …` hint. */
const COPILOT_NOTIFICATION_AGENT_ID_RE = /agent_id[:\s]+"?([\w.-]*[\w-])/i
/** A `read_agent` result's status line (`Agent is idle (waiting for messages). agent_id: <id>,
 *  agent_type: …, status: idle, …`): the agent is no longer running a turn. */
const COPILOT_READ_AGENT_STATUS_RE =
  /^\s*Agent\b[^\n]*?\bagent_id:\s*([\w.-]*[\w-]),[^\n]*?\bstatus:\s*(\w+)/
const COPILOT_READ_AGENT_ENDED_STATUSES = new Set(['idle', 'completed', 'failed', 'cancelled'])

export function readBackgroundAgentId(resultText: string | undefined): string | undefined {
  return resultText?.match(COPILOT_BACKGROUND_AGENT_RE)?.[1] || undefined
}

/** The agent a `read_agent` result reports no longer running. Only the line's FIRST `status:`
 *  counts, since the model-written description after it can contain the same words. */
export function readEndedAgentIdFromReadAgent(
  resultText: string | undefined,
  requestedAgentId: unknown
): string | undefined {
  const match = resultText?.match(COPILOT_READ_AGENT_STATUS_RE)
  if (!match || !COPILOT_READ_AGENT_ENDED_STATUSES.has(match[2].toLowerCase())) {
    return undefined
  }
  return typeof requestedAgentId === 'string' && requestedAgentId !== match[1]
    ? undefined
    : match[1]
}

export function readCopilotAgentNotificationAgentId(
  hookPayload: Record<string, unknown>
): string | undefined {
  const message = readFirstString(hookPayload, ['message', 'body', 'text'])
  return message?.match(COPILOT_NOTIFICATION_AGENT_ID_RE)?.[1] || undefined
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
