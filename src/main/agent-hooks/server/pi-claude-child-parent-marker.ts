import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  PI_CLAUDE_PARENT_MARKER_TYPE,
  PI_CLAUDE_PARENT_MARKER_VERSION,
  piClaudeParentMarkerPath,
  type PiClaudeParentMarker
} from '../../../shared/pi-claude-parent-marker'

/** The link a child's own hook post established, as the listener recorded it. */
type ChildParentLink = NonNullable<AgentHookEventPayload['piClaudeChildParent']>

/** Marker paths already written for a (transcript, run) pair in this process.
 *
 *  The child posts dozens of events and the content cannot change, so one `existsSync` per run is
 *  enough — and this keeps the main thread off the filesystem for the rest of them. */
const writtenMarkers = new Set<string>()

function markerKey(link: ChildParentLink, parentSessionId: string): string {
  return `${piClaudeParentMarkerPath(link.transcriptPath)}\u0000${parentSessionId}\u0000${link.runId}`
}

/** A marker this process already wrote, or one already on disk saying the same thing. */
function alreadyWritten(path: string, parentSessionId: string, runId: string): boolean {
  if (!existsSync(path)) {
    return false
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) {
      return false
    }
    const record: Record<string, unknown> = { ...raw }
    return (
      record['type'] === PI_CLAUDE_PARENT_MARKER_TYPE &&
      record['parentSessionId'] === parentSessionId &&
      record['runId'] === runId
    )
  } catch {
    return false
  }
}

/** Whether the post's own name for its conversation matches the file it points at.
 *
 *  A marker makes the AI Vault nest one transcript under a pi session, so a post that names a
 *  different conversation than its transcript would attribute somebody else's session. */
function transcriptMatchesConversation(link: ChildParentLink): boolean {
  return basename(link.transcriptPath) === `${link.providerSession}.jsonl`
}

/**
 * Record, beside a claude CLI child's own transcript, which pi session spawned it.
 *
 * The AI Vault scans that directory and knows nothing about hooks, so the link has to live on disk
 * and travel with the transcript. Read only on the machine that holds the transcript: a paired or
 * SSH host's own hook server writes its own markers, and a relay — which forwards events it cannot
 * scan — writes none, so those lists keep today's behaviour.
 *
 * Deliberately best-effort. A read-only Claude home, a full disk, a path that vanished: none of them
 * may cost the status row this call rides on, and all of them degrade to the session list showing
 * the child as its own conversation, exactly as it did before.
 */
export function writePiClaudeChildParentMarker(
  link: ChildParentLink | undefined,
  paneKey: string,
  previous: EnrichedAgentHookEventPayload | undefined,
  now: number
): void {
  const parentSessionId = previous?.providerSession?.id
  if (!link || !parentSessionId || !transcriptMatchesConversation(link)) {
    return
  }
  const parentAgent = previous?.source ?? previous?.payload.agentType
  const key = markerKey(link, parentSessionId)
  if (writtenMarkers.has(key)) {
    return
  }
  try {
    const path = piClaudeParentMarkerPath(link.transcriptPath)
    if (!alreadyWritten(path, parentSessionId, link.runId)) {
      const marker: PiClaudeParentMarker = {
        type: PI_CLAUDE_PARENT_MARKER_TYPE,
        version: PI_CLAUDE_PARENT_MARKER_VERSION,
        parentSessionId,
        ...(parentAgent ? { parentAgent } : {}),
        ...(previous?.providerSession?.transcriptPath
          ? { parentTranscriptPath: previous.providerSession.transcriptPath }
          : {}),
        runId: link.runId,
        parentPaneKey: paneKey,
        writtenAt: now
      }
      // Why a temp path then a rename: the vault scanner may list the directory while this writes,
      // and a half-written marker would parse as none at all.
      const temporary = `${path}.${process.pid}.tmp`
      try {
        writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        renameSync(temporary, path)
      } catch (error) {
        // A failed write must not leave its scratch file behind for the next scan to find.
        rmSync(temporary, { force: true })
        throw error
      }
    }
    writtenMarkers.add(key)
  } catch {
    // See above: the session list degrades, the live row does not.
  }
}
