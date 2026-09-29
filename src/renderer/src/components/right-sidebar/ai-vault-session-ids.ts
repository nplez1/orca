/**
 * The identity key for a pane's live agent sessions.
 *
 * Why separate: this selector runs on every store write, so the key is indexed once per immutable
 * status snapshot. Extracted from `ai-vault-session-refresh.ts` to keep that hook under the
 * max-lines budget.
 */

// Why resettable: every production writer replaces the map, but test fixtures commonly
// mutate `mockStoreState.agentStatusByPaneKey[key]` in place, which would keep serving the
// key cached for the identity they mutated.
let agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()

export function resetAiVaultSessionIdsKeyForTest(): void {
  agentSessionIdsKeyBySnapshot = new WeakMap<object, string>()
}

export function getAgentSessionIdsKey(
  agentStatusByPaneKey: Record<string, { providerSession?: { id?: string } | null }> | undefined
): string {
  if (!agentStatusByPaneKey) {
    return ''
  }
  const cached = agentSessionIdsKeyBySnapshot.get(agentStatusByPaneKey)
  if (cached !== undefined) {
    return cached
  }
  const ids: string[] = []
  for (const entry of Object.values(agentStatusByPaneKey)) {
    if (entry.providerSession?.id) {
      ids.push(entry.providerSession.id)
    }
  }
  const key = ids.sort().join('\n')
  agentSessionIdsKeyBySnapshot.set(agentStatusByPaneKey, key)
  return key
}
