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

/** One background agent known by the `agent_id` its launch result reported. */
export type CopilotBackgroundAgent = {
  agentId: string
  /** Running a turn; an idle agent (waiting for `write_agent`) holds nothing. */
  running: boolean
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
    work.backgroundAgents.filter((agent) => agent.running).length
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
 *  arrive. Never touches pending shells, so a redundant agent completion cannot settle one. An
 *  id-less completion may end a rostered agent; one naming an unrostered agent may not. */
export function consumeCopilotSubagent(
  work: CopilotBackgroundWorkState,
  options: { includeRoster: boolean } = { includeRoster: true }
): CopilotBackgroundWorkState {
  if (work.pendingSubagentLifecycleCount > 0) {
    return { ...work, pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount - 1 }
  }
  if (work.pendingUnidentifiedSubagentCount > 0 || !options.includeRoster) {
    return {
      ...work,
      pendingUnidentifiedSubagentCount: Math.max(0, work.pendingUnidentifiedSubagentCount - 1)
    }
  }
  const index = work.backgroundAgents.findIndex((agent) => agent.running)
  return index === -1 ? work : setAgentAt(work, index, { running: false, awaitingStart: false })
}

function setAgentAt(
  work: CopilotBackgroundWorkState,
  index: number,
  patch: Partial<CopilotBackgroundAgent>
): CopilotBackgroundWorkState {
  const backgroundAgents = [...work.backgroundAgents]
  backgroundAgents[index] = { ...backgroundAgents[index], ...patch }
  return { ...work, backgroundAgents }
}

/** A launch result named this background agent: it takes over the anonymous entry its launch or
 *  `SubagentStart` counted, so later completions are matched to it by id. */
export function registerCopilotBackgroundAgent(
  work: CopilotBackgroundWorkState,
  agentId: string
): CopilotBackgroundWorkState {
  const index = work.backgroundAgents.findIndex((agent) => agent.agentId === agentId)
  if (index !== -1) {
    return setAgentAt(work, index, { running: true })
  }
  const add = (next: CopilotBackgroundWorkState, awaitingStart: boolean) => ({
    ...next,
    backgroundAgents: [...next.backgroundAgents, { agentId, running: true, awaitingStart }]
  })
  if (work.pendingUnidentifiedSubagentCount > 0) {
    return add(
      { ...work, pendingUnidentifiedSubagentCount: work.pendingUnidentifiedSubagentCount - 1 },
      true
    )
  }
  if (work.pendingSubagentLifecycleCount > 0) {
    return add(
      { ...work, pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount - 1 },
      false
    )
  }
  return add(work, true)
}

/** `write_agent` starts an idle agent's next turn (or steers a running one). */
export function reengageCopilotBackgroundAgents(
  work: CopilotBackgroundWorkState,
  agentIds: readonly string[]
): CopilotBackgroundWorkState {
  let next = work
  for (const agentId of agentIds) {
    const index = next.backgroundAgents.findIndex((agent) => agent.agentId === agentId)
    next =
      index === -1
        ? {
            ...next,
            backgroundAgents: [
              ...next.backgroundAgents,
              { agentId, running: true, awaitingStart: true }
            ]
          }
        : next.backgroundAgents[index].running
          ? next
          : setAgentAt(next, index, { running: true, awaitingStart: true })
  }
  return next
}

/** `SubagentStart` carries no agent id; it belongs to a rostered agent still awaiting it, else it
 *  claims an anonymous launch (or a launch this pane never saw). */
export function startCopilotSubagent(work: CopilotBackgroundWorkState): CopilotBackgroundWorkState {
  const index = work.backgroundAgents.findIndex((agent) => agent.awaitingStart)
  if (index !== -1) {
    return setAgentAt(work, index, { awaitingStart: false })
  }
  return {
    ...work,
    pendingUnidentifiedSubagentCount: Math.max(0, work.pendingUnidentifiedSubagentCount - 1),
    pendingSubagentLifecycleCount: work.pendingSubagentLifecycleCount + 1
  }
}

/** End one agent's turn by id: idle and completed both leave nothing running, and a duplicate
 *  report for an agent already ended is a no-op instead of consuming a different one. */
export function endCopilotSubagent(
  work: CopilotBackgroundWorkState,
  agentId: string | undefined
): CopilotBackgroundWorkState {
  const index =
    agentId === undefined
      ? -1
      : work.backgroundAgents.findIndex((agent) => agent.agentId === agentId)
  if (index !== -1) {
    return setAgentAt(work, index, { running: false, awaitingStart: false })
  }
  return consumeCopilotSubagent(work, { includeRoster: agentId === undefined })
}

// ─── How Copilot names a background agent ────────────────────────────────────

/** `Agent started in background with agent_id: <id>`, `MCP task started in background with
 *  agent_id: <id>`, or a sync task's `Agent moved to background (agent_id: <id>)`. */
const COPILOT_BACKGROUND_AGENT_RE =
  /(?:started in background with agent_id:|moved to background \(agent_id:)\s*([\w.-]*[\w-])/i
/** An agent notification's `Use read_agent with agent_id "<id>" …` hint. */
const COPILOT_NOTIFICATION_AGENT_ID_RE = /agent_id[:\s]+"?([\w.-]*[\w-])/i

export function readBackgroundAgentId(resultText: string | undefined): string | undefined {
  return resultText?.match(COPILOT_BACKGROUND_AGENT_RE)?.[1]?.trim() || undefined
}

export function readCopilotAgentNotificationAgentId(
  hookPayload: Record<string, unknown>
): string | undefined {
  const message = readFirstString(hookPayload, ['message', 'body', 'text'])
  return message?.match(COPILOT_NOTIFICATION_AGENT_ID_RE)?.[1]?.trim() || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Copilot's own refusals for a `write_agent` that reached no agent. */
const COPILOT_WRITE_AGENT_UNDELIVERED_RE =
  /No agent found|not accepting messages|only supports background agents|No matching agents|Delivery failed|Failed to deliver/i

/** The agents a delivered `write_agent` addressed by id; a `scope` send names none. */
export function readCopilotWriteAgentTargets(
  toolName: string | undefined,
  toolInput: unknown,
  resultText: string | undefined
): string[] {
  if (toolName?.toLowerCase() !== 'write_agent' || !isRecord(toolInput)) {
    return []
  }
  if (resultText && COPILOT_WRITE_AGENT_UNDELIVERED_RE.test(resultText)) {
    return []
  }
  const ids: unknown[] =
    typeof toolInput.agent_id === 'string'
      ? [toolInput.agent_id]
      : Array.isArray(toolInput.agent_ids)
        ? toolInput.agent_ids
        : []
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
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
