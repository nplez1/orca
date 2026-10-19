/**
 * The one definition of the sidecar that links a `claude --print` child's conversation to the pi
 * session that spawned it.
 *
 * Shared because two subsystems read it from opposite directions: the hook listener writes it
 * beside a transcript it can see, and the AI Vault scanner reads it while listing that transcript.
 * A suffix or a `type` string duplicated in both would drift the day one of them changes.
 */
export const PI_CLAUDE_PARENT_MARKER_SUFFIX = '.pi-parent.json'
export const PI_CLAUDE_PARENT_MARKER_TYPE = 'orca-pi-claude-subagent'
export const PI_CLAUDE_PARENT_MARKER_VERSION = 1

/** What the marker records. Only `parentSessionId` is consulted for nesting. */
export type PiClaudeParentMarker = {
  type: typeof PI_CLAUDE_PARENT_MARKER_TYPE
  version: number
  parentSessionId: string
  /** The agent that owns the parent session, so a list filtered to another agent can still tell a
   *  cross-agent link from a parent that is merely not loaded. */
  parentAgent?: string
  parentTranscriptPath?: string
  runId: string
  parentPaneKey?: string
  writtenAt: number
}

/** `<projectDir>/<claude-uuid>.jsonl` → `<projectDir>/<claude-uuid>.pi-parent.json`. */
export function piClaudeParentMarkerPath(transcriptPath: string): string {
  const stem = transcriptPath.endsWith('.jsonl')
    ? transcriptPath.slice(0, -'.jsonl'.length)
    : transcriptPath
  return `${stem}${PI_CLAUDE_PARENT_MARKER_SUFFIX}`
}
