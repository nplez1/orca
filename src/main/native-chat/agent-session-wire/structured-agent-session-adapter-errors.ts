import type { AgentSessionRefusalReason } from '../../../shared/agent-session-wire-refusals'

// The adapter's refusal vocabulary, split from structured-agent-session-adapter.ts once that
// file crossed the max-lines cap. The adapter re-exports every name here, so `./structured-
// agent-session-adapter` stays the import site for the claude, codex, and runtime callers.

export class AgentSessionAcquisitionRefusal extends Error {
  readonly code = 'agent_session_operation_invalid'

  constructor(
    message: string,
    /** The situation, so the chat can say what to do; the message is Orca's log wording. Absent,
     *  the provider refused its own start. */
    readonly reason: AgentSessionRefusalReason<'agent_session_operation_invalid'> = 'providerStartFailed'
  ) {
    super(message)
    this.name = 'AgentSessionAcquisitionRefusal'
  }

  /** The conversation's history is more than this host can restore. */
  static historyTooLarge(message: string): AgentSessionAcquisitionRefusal {
    return new AgentSessionAcquisitionRefusal(message, 'historyTooLarge')
  }
}

export class AgentSessionPromptUnavailableError extends Error {
  constructor(itemId: string) {
    super(`The provider is no longer waiting on ${itemId}.`)
    this.name = 'AgentSessionPromptUnavailableError'
  }
}

/** The provider cannot take this answer. Thrown before the journal commit, so nothing is recorded. */
export class AgentSessionPromptAnswerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionPromptAnswerRejectedError'
  }
}

/**
 * The provider's own root process was observed to exit, but its descendant tree
 * was not proven gone. The lease keys on the root's pid and start time, so its
 * observed death releases the reservation; nothing is claimed about descendants,
 * including one seen still alive.
 */
export class AgentSessionAcquisitionRootExitObservedError extends Error {
  constructor(cause: unknown) {
    // The provider's own diagnostic is the only thing the user can act on.
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionRootExitObservedError'
  }
}

/** The provider child failed and cleanup proved its whole tree gone. As with a root exit, the
 *  provider's own diagnostic is the message. */
export class AgentSessionAcquisitionExitProvenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionExitProvenError'
  }
}

export class AgentSessionAcquisitionExitUnprovenError extends Error {
  constructor(cause: unknown) {
    super('agent_session_acquisition_exit_unproven', { cause })
    this.name = 'AgentSessionAcquisitionExitUnprovenError'
  }
}

/** A refusal before spawn that a person can act on; the site that refused names it. */
export type AgentSessionPreSpawnReason = Extract<
  AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  'managedAccountEnvOverride' | 'accountSwitchInProgress' | 'managedAccountUnsupported'
>

/** Acquisition failed with first-hand proof that no provider process existed. */
export class AgentSessionPreSpawnError extends Error {
  /** Absent: Orca's own reason, which only the log reads. A wrapped pre-spawn error keeps its. */
  readonly reason: AgentSessionPreSpawnReason | undefined

  constructor(
    cause: unknown,
    options: { reason?: AgentSessionPreSpawnReason; message?: string } = {}
  ) {
    super(options.message ?? (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'AgentSessionPreSpawnError'
    this.reason = options.reason ?? (isAgentSessionPreSpawnError(cause) ? cause.reason : undefined)
  }
}

export function isAgentSessionPreSpawnError(error: unknown): error is AgentSessionPreSpawnError {
  return error instanceof Error && error.name === 'AgentSessionPreSpawnError'
}
