import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSessionSubagentInfo } from '../../shared/ai-vault-types'
import {
  PI_CLAUDE_PARENT_MARKER_TYPE,
  piClaudeParentMarkerPath
} from '../../shared/pi-claude-parent-marker'
import { extractString, parseJsonObject } from './session-scanner-values'

/**
 * A `claude --print` child spawned by a pi session writes its conversation as an ordinary root
 * transcript, so nothing inside it names the session that spawned it. Orca's hook listener leaves
 * a marker beside it instead, once the child's hook stream is attributed to its parent — that
 * marker is the only durable record of the lineage, and AI Vault nests the row from it.
 *
 * Layout: `<projectDir>/<claude-uuid>.jsonl` ↔ `<projectDir>/<claude-uuid>.pi-parent.json`.
 * Absent for every session a person opened directly, and for every host that does not write it.
 */
export const claudePiParentMarkerPath = piClaudeParentMarkerPath

/**
 * The parent link a Claude transcript's marker declares, or null.
 *
 * Every failure is "no marker", never an error: the row then stays a top-level session, which is
 * the safe direction — a missing link shows a duplicate row, while a wrong one hides a real session
 * under a parent it does not belong to.
 */
export async function readClaudePiParentMarker(
  transcriptFilePath: string
): Promise<AiVaultSessionSubagentInfo | null> {
  let raw: string
  try {
    raw = await wslGatedReadFile(claudePiParentMarkerPath(transcriptFilePath), 'utf-8', 'scan')
  } catch {
    return null
  }
  const marker = parseJsonObject(raw)
  if (!marker || extractString(marker.type) !== PI_CLAUDE_PARENT_MARKER_TYPE) {
    return null
  }
  const parentSessionId = extractString(marker.parentSessionId)?.trim()
  if (!parentSessionId) {
    return null
  }
  // The marker names no run status, and its agent type is the child's own, which the row already
  // carries; what it adds is the AGENT of the parent, which a filtered list needs.
  const parentAgent = extractString(marker.parentAgent)?.trim()
  return {
    parentSessionId,
    agentType: null,
    status: null,
    ...(parentAgent ? { parentAgent } : {})
  }
}
