// The fold's transcript source, dispatched by the host that owns the session.
//
// Local sessions and SSH sessions end in the same parser over the same event list —
// the only difference is whether the bytes are opened here or fetched first. Paired
// Orca hosts never reach this: they fold their own sessions in place.
import type { RemoteTranscriptFetch } from './session-summary-remote-transcript'
import { REMOTE_TRANSCRIPT_MAX_BYTES } from './session-summary-remote-transcript'
import type {
  SessionSummaryEventRead,
  SessionSummarySessionIdentity
} from './session-summary-transcript-source'
import {
  readSessionSummaryEventsFromFile,
  readSessionSummaryTranscriptEvents,
  resolveRemoteTranscriptParser
} from './session-summary-transcript-source'
import type { SessionSummaryTranscriptHost } from './session-summary-transcript-host'

export type SessionSummaryEventReaderDeps = {
  fetchSshTranscript: (args: {
    targetId: string
    remotePath: string
    signal: AbortSignal
  }) => Promise<RemoteTranscriptFetch>
}

export function createSessionSummaryEventReader(
  deps: SessionSummaryEventReaderDeps
): (args: {
  identity: SessionSummarySessionIdentity
  host: SessionSummaryTranscriptHost
  signal: AbortSignal
  fromEventIndex?: number
}) => Promise<SessionSummaryEventRead | null> {
  return async ({ identity, host, signal, fromEventIndex }) => {
    if (host.kind === 'local') {
      return readSessionSummaryTranscriptEvents({ identity, signal, fromEventIndex })
    }
    // Nothing is read on a host we cannot name; the pane says why instead.
    if (host.kind !== 'ssh') {
      return null
    }
    // Only a hook-named path: on that host, no root search or synthesized Copilot
    // directory is available to locate a transcript this app was not told about.
    const remotePath = identity.providerSession?.transcriptPath?.trim()
    const parser = identity.agentType ? resolveRemoteTranscriptParser(identity.agentType) : null
    if (!remotePath || !parser) {
      return null
    }
    const fetched = await deps.fetchSshTranscript({ targetId: host.targetId, remotePath, signal })
    if (fetched.kind === 'missing') {
      return null
    }
    if (fetched.kind === 'too-large') {
      // Why fail instead of truncating: a shortened transcript renumbers every event,
      // and the ledger's cursor would then point at different messages.
      throw new Error(
        `This session's transcript is over ${formatMegabytes(
          REMOTE_TRANSCRIPT_MAX_BYTES
        )}, which is too large to read from a remote host.`
      )
    }
    try {
      return await readSessionSummaryEventsFromFile({
        filePath: fetched.path,
        parser,
        signal,
        fromEventIndex
      })
    } finally {
      void fetched.dispose()
    }
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}
