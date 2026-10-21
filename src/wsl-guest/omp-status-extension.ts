import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isManagedPiExtensionInPlace,
  writeManagedPiExtension
} from '../shared/managed-pi-extension-file'

export function writeRelayOmpStatusExtension(homeDir: string, source: string): string | null {
  const directory = join(homeDir, '.orca-relay', 'omp-managed-status-extension')
  const path = join(directory, 'orca-agent-status.ts')
  try {
    mkdirSync(directory, { recursive: true })
    // Why: an already-current file keeps its mtime so the agent's compiled-extension
    // metadata survives a relaunch; a user-owned same-named file is never touched.
    const written = writeManagedPiExtension(path, source)
    if (written === 'failed') {
      process.stderr.write(
        `[plugin-overlay] failed to write OMP managed status extension: ${path}\n`
      )
      return null
    }
    return isManagedPiExtensionInPlace(written) ? path : null
  } catch (err) {
    process.stderr.write(
      `[plugin-overlay] failed to write OMP managed status extension: ${err instanceof Error ? err.message : String(err)}\n`
    )
    return null
  }
}
