/**
 * Which paired hosts hold which replicated credential, on the main machine.
 *
 * Why a ledger rather than a re-ask: revocation has to reach every host that ever received a
 * credential, including one that is offline right now, and "which hosts hold this token" is not a
 * question any single host can answer. It also answers the reverse question the settings pane needs
 * — which credentials a host holds — without granting that host anything.
 */

export type HostSettingsCredentialLedger = {
  version: 1
  /** Credential id → the paired host ids that received it. */
  hostsByCredential: Record<string, string[]>
}

export const EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER: HostSettingsCredentialLedger = {
  version: 1,
  hostsByCredential: {}
}

/** Record that a host received these credentials, idempotently. */
export function recordCredentialHoldings(
  ledger: HostSettingsCredentialLedger,
  input: { credentialIds: readonly string[]; hostId: string }
): HostSettingsCredentialLedger {
  const hostsByCredential = { ...ledger.hostsByCredential }
  for (const credentialId of input.credentialIds) {
    const holders = hostsByCredential[credentialId] ?? []
    hostsByCredential[credentialId] = holders.includes(input.hostId)
      ? holders
      : [...holders, input.hostId].sort()
  }
  return { version: 1, hostsByCredential }
}

export function credentialHolders(
  ledger: HostSettingsCredentialLedger,
  credentialId: string
): string[] {
  return ledger.hostsByCredential[credentialId] ?? []
}

/**
 * Drop one credential's record.
 *
 * `hostIds` is required rather than implicit: a host whose revocation could not be verified must
 * keep its holding, or the next disconnect has nothing left to retry against and the token stays
 * on a host the user believes is clean.
 */
export function forgetCredentialHoldings(
  ledger: HostSettingsCredentialLedger,
  credentialId: string,
  hostIds: readonly string[]
): HostSettingsCredentialLedger {
  const hostsByCredential = { ...ledger.hostsByCredential }
  const remaining = (hostsByCredential[credentialId] ?? []).filter(
    (hostId) => !hostIds.includes(hostId)
  )
  if (remaining.length === 0) {
    delete hostsByCredential[credentialId]
  } else {
    hostsByCredential[credentialId] = remaining
  }
  return { version: 1, hostsByCredential }
}

/** Forget a host entirely — the unpair path, where nothing on it is ours any more. */
export function forgetHostHoldings(
  ledger: HostSettingsCredentialLedger,
  hostId: string
): HostSettingsCredentialLedger {
  const hostsByCredential: Record<string, string[]> = {}
  for (const [credentialId, holders] of Object.entries(ledger.hostsByCredential)) {
    const remaining = holders.filter((holder) => holder !== hostId)
    if (remaining.length > 0) {
      hostsByCredential[credentialId] = remaining
    }
  }
  return { version: 1, hostsByCredential }
}

/** How the main reaches a host to delete a credential there. */
export type HostSettingsRevocationTransport = {
  revoke(hostId: string, credentialId: string): Promise<void>
  /** Whether that host's own store still answers with the credential. */
  holds(hostId: string, credentialId: string): Promise<boolean>
}

export type HostSettingsRevocationResult = {
  credentialId: string
  hostId: string
  outcome: 'revoked' | 'unreachable' | 'stillHeld'
}

/**
 * Delete one credential from every host the ledger says holds it, and prove the deletion.
 *
 * Why unreachable is its own outcome and not a failure: losing contact with a host is never evidence
 * that a process died or a file was deleted (the repo's execution-host rule), so the honest report
 * is "we could not get there". That host keeps its ledger entry and the next disconnect retries.
 */
export async function revokeReplicatedCredential(input: {
  credentialId: string
  ledger: HostSettingsCredentialLedger
  transport: HostSettingsRevocationTransport
}): Promise<{ results: HostSettingsRevocationResult[]; ledger: HostSettingsCredentialLedger }> {
  const { credentialId, ledger, transport } = input
  const results: HostSettingsRevocationResult[] = []

  for (const hostId of credentialHolders(ledger, credentialId)) {
    let outcome: HostSettingsRevocationResult['outcome']
    try {
      await transport.revoke(hostId, credentialId)
      outcome = (await transport.holds(hostId, credentialId)) ? 'stillHeld' : 'revoked'
    } catch {
      outcome = 'unreachable'
    }
    results.push({ credentialId, hostId, outcome })
  }

  const revoked = results.filter((result) => result.outcome === 'revoked').map((r) => r.hostId)
  return { results, ledger: forgetCredentialHoldings(ledger, credentialId, revoked) }
}
