// Agent-session capability IDs, split from protocol-version.ts once that catalog
// crossed the max-lines cap. Every declaration here is re-exported there, so
// `@shared/protocol-version` stays the single import site for consumers.

export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const
export const AGENT_SESSION_HOST_AUTHORITY_RUNTIME_CAPABILITY =
  'agent-session.host-authority.v1' as const
// Older launch schemas reject unknown fields; advertise before clients send keyboard support.
export const AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY = 'agent-session.keyboard.v1' as const
export const AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY =
  'agent-session.omp-resume-path.v1' as const
// Why: structured sessions are journal-backed, not PTY-backed, so an incapable client must not
// receive their journal or drive their lifecycle. Mobile may receive a metadata-only placeholder;
// the host still refuses agentSession.* methods and destructive tab mutations without capability.
export const STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY = 'agent-session.structured.v1' as const
// Why: older structured clients render durable pending replies as uncertain delivery. Capable
// clients skip the host's bounded best-effort settlement observation.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Why: a send is now answered once the host accepts it, before any agent has it. A client without
// this cannot show a message rejected after that answer, so the host holds its reply until the
// message is handed over or rejected. Transitional: drop the hold once no supported desktop or
// mobile client lacks the capability; mobile must first show a rejected message in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Why: `agentSession.cancel` params are strict and older hosts require `turnId`. A host advertising
// this takes a cancel naming no turn as "stop what the conversation has in flight", which is the
// only Stop a client can send before the provider has opened a turn.
export const AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY =
  'agent-session.conversation-stop.v1' as const
// Why: `agentSession.send`'s params are strict, so an older host rejects `delivery`; and only a
// capable client can render the `queued` result arm, the draft list, and returned cards. DARK ON
// PURPOSE — not in RUNTIME_CAPABILITIES: advertising still requires the integrated Codex steer
// matrix (#21062) in the shipped host, and the desktop and phone clients that render the queue.
// v1 includes `submission.queuedMessageId` on every draft hand-off: a client reads that link and
// never compares a draft id with a submission id. It also publishes the queue's pause once, as
// `queuePause` beside the list, lifted by `agentSession.queuedMessagesResume` or the user's next
// turn; cards carry a hold of their own only when their conversion failed. The host mechanism lands first, the constant
// gates the rollout.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const
// Why: paired clients advertise Claude-structured support so the host can gate its agent-specific
// journal and lifecycle surfaces independently from Codex support.
export const CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY =
  'agent-session.structured.claude.v1' as const
// Why: paired structured clients explicitly hold every visible session surface, allowing the host
// to stop provider children after the last surface closes without tying lifetime to a transport.
export const STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.hold.v1' as const
// Why: a client holding only a session id — an Agent Session History row — asks the host to
// republish that chat's tab. An older host has no such method, and a client must learn that during
// negotiation rather than by calling and reading a refusal it cannot distinguish from a real one.
export const STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY =
  'agent-session.structured.reveal.v1' as const
// Why: `agentSession.create` gains an optional `resumeFrom`, and its params are a STRICT union — an
// older host rejects the unknown key as a schema error, which a client cannot tell from a real
// refusal. Worse, without probing, a client cannot know whether a host that accepted the call
// adopted the conversation or quietly started a blank one. Negotiate before offering the action.
export const STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY =
  'agent-session.structured.resume-history.v1' as const
// Why: agentSession.subscribeStatus is additive to a surface that already shipped, so a host
// advertising agent-session.structured.v1 may still answer it with method_not_found. Clients must
// probe before subscribing or they reconnect forever and never show any status at all.
export const AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY = 'agent-session.status-feed.v1' as const
// Why separate from the status feed: a host can carry the status feed and not this stream, and a
// decoder drops an unknown stream opcode in silence. A client that subscribed without probing
// would wait forever for completions the host never sends and report nothing wrong.
export const AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY =
  'agent-session.turn-completion.v1' as const
// Why: agentSession.conversationOutline is additive; a client probes this before calling so an
// older host leaves the message rail on loaded messages instead of answering method_not_found.
export const AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY =
  'agent-session.conversation-outline.v1' as const
// The RPC is registered unconditionally; per-session rewind support is a separate check.
export const AGENT_SESSION_REWIND_RUNTIME_CAPABILITY = 'agent-session.rewind.v1' as const
// Readers must understand a monitoring roster with no available stop control.
// Why: a `turn` journal item replaced the status row that used to carry a turn's lifecycle. A
// client that predates it would render the unknown kind as text, so the host publishes the legacy
// status form to clients that do not advertise this. Transitional: drop the downgrade once no
// supported release lacks the capability.
export const AGENT_SESSION_TURN_ITEM_CAPABILITY = 'agent-session.turn-item.v1' as const
export const AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY =
  'agent-session.background-task-stop.v1' as const
// Why: agentSession.cancel has a strict schema, so clients must not send prompt identity to an
// older host that would reject the whole cancellation instead of falling back to turn stop.
export const AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY =
  'agent-session.prompt-cancel.v1' as const
// Why: agentSession.respondToQuestion has a strict schema, so clients must not send structured
// `answers` to an older host; they fall back to the answer packed into `optionId`.
export const AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY =
  'agent-session.question-answers.v1' as const
// Why: the host now publishes rows for work that is live inside a turn, and such
// a row carries `stoppable: false` because no targeted stop can reach it. A
// reader that predates the field draws a per-row Stop on every row it is given,
// so it must be told apart from one that honours the field — and NOT by the
// stop capability above, which a client can advertise while predating this.
export const AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY =
  'agent-session.background-task-row-stop.v1' as const
// Why: adding kimi to RESUMABLE_TUI_AGENTS grows terminal.ensureAgentSession's enum, and an
// older host answers the unknown member with invalid_argument — a code the launch fallback does
// not retry on — so clients must probe before taking the host-authority path.
export const AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY = 'agent-session.kimi-resume.v1' as const
export const AGENT_SESSION_OPENCODE2_RESUME_RUNTIME_CAPABILITY =
  'agent-session.opencode2-resume.v1' as const
export const AGENT_SESSION_MUSE_RESUME_RUNTIME_CAPABILITY = 'agent-session.muse-resume.v1' as const
export const AGENT_SESSION_DSH_RESUME_RUNTIME_CAPABILITY = 'agent-session.dsh-resume.v1' as const
export const AGENT_SESSION_CODEBUDDY_RESUME_RUNTIME_CAPABILITY =
  'agent-session.codebuddy-resume.v1' as const
export const AGENT_SESSION_QODER_RESUME_RUNTIME_CAPABILITY =
  'agent-session.qoder-resume.v1' as const
export const AGENT_SESSION_ZCODE_RESUME_RUNTIME_CAPABILITY =
  'agent-session.zcode-resume.v1' as const
