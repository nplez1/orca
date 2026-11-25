import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'
import { editAgentTrustConfig, parseAgentTrustConfig } from './agent-trust-config-jsonc'

/**
 * Worker-only: removes the `trustedWorkspaces` entries Orca appended for `workspacePath`, keeping
 * any the user had or changed. Runs on the Codex project trust worker so its reads and Windows
 * rename retries stay off Electron main. Never throws.
 */
export function removeOrcaCreatedAntigravityTrust(ledgerPath: string, workspacePath: string): void {
  // Why resolve, not realpath: removal runs after the worktree directory is gone.
  const ownership = createAgentTrustOwnershipLedger(
    () => ledgerPath,
    (projectPath) => resolve(projectPath)
  )
  for (const settingsPath of ownership.listConfigFiles(workspacePath)) {
    try {
      const entry = ownership.getWritten(settingsPath, workspacePath)
      if (entry !== null && existsSync(settingsPath)) {
        removeEntry(settingsPath, entry)
      }
      ownership.forget(settingsPath, workspacePath)
    } catch (error) {
      // Why: keep the record so a later removal can retry an unreadable settings file.
      console.warn('[antigravity-trust] Failed to remove an Orca-created trust entry:', error)
    }
  }
}

function removeEntry(settingsPath: string, entry: string): void {
  const text = readFileSync(settingsPath, 'utf-8')
  const config = parseAgentTrustConfig(text)
  if (!config) {
    return
  }
  const trusted: unknown[] = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : []
  let next = text
  // Remove items last to first so earlier indexes stay valid; comments elsewhere survive.
  for (let index = trusted.length - 1; index >= 0; index -= 1) {
    if (trusted[index] === entry) {
      next = editAgentTrustConfig(next, ['trustedWorkspaces', index], undefined)
    }
  }
  if (next !== text) {
    writeFileAtomically(settingsPath, next)
  }
}
