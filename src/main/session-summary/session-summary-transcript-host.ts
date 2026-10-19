// Where a session's transcript can be read. The fold brain always runs locally
// (it spawns the user's configured agent CLI), so a remote session only needs its
// transcript brought here — never a remote fold. See docs/reference/session-summary.md.
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'

export type SessionSummaryTranscriptHost =
  /** This machine: the transcript path is opened directly. */
  | { kind: 'local' }
  /** An SSH target: the path is read over the connection Orca already holds. */
  | { kind: 'ssh'; hostId: ExecutionHostId; targetId: string }
  /** A paired Orca server: the path is read in chunks over `sessionSummary.readTranscript`. */
  | { kind: 'runtime'; hostId: ExecutionHostId; environmentId: string }
  /**
   * A host id this build cannot parse — a newer host kind, which is not local, so
   * opening its path here would be a lie about where the session lives.
   */
  | { kind: 'unsupported'; hostId: string }

/**
 * The host a pane's transcript must be read from.
 *
 * `connectionId` is the hook row's own evidence: remote rows are ingested with the
 * connection they arrived on (`server-ingest-remote.ts`), and a transcript path only
 * means anything on the machine that wrote it. The request's `executionHostId` answers
 * for panes with no row left — the client clears connection rows after a reconnect —
 * and for paired-server workspaces, where no row names a host at all.
 */
export function resolveSessionSummaryTranscriptHost(args: {
  requestedHostId?: string | null
  connectionId?: string | null
}): SessionSummaryTranscriptHost {
  const connectionId = args.connectionId?.trim()
  if (connectionId) {
    return {
      kind: 'ssh',
      hostId: toSshExecutionHostId(connectionId),
      targetId: connectionId
    }
  }
  const requested = args.requestedHostId?.trim()
  if (!requested) {
    return { kind: 'local' }
  }
  const parsed = parseExecutionHostId(requested)
  if (!parsed) {
    return { kind: 'unsupported', hostId: requested }
  }
  switch (parsed.kind) {
    case 'local':
      return { kind: 'local' }
    case 'ssh':
      return { kind: 'ssh', hostId: parsed.id, targetId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}
