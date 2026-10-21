import { readFileSync, writeFileSync } from 'node:fs'

export const ORCA_MANAGED_PI_EXTENSION_MARKER = '@orca-managed-pi-extension'

export type ManagedPiExtensionWrite = 'written' | 'unchanged' | 'skipped-user-owned' | 'failed'

export function withOrcaManagedPiExtensionMarker(source: string): string {
  return source.includes(ORCA_MANAGED_PI_EXTENSION_MARKER)
    ? source
    : `// ${ORCA_MANAGED_PI_EXTENSION_MARKER}\n${source}`
}

/** `unchanged` leaves a usable managed file in place; only a skipped or failed write needs a fallback. */
export function isManagedPiExtensionInPlace(result: ManagedPiExtensionWrite): boolean {
  return result === 'written' || result === 'unchanged'
}

/**
 * Install Orca's source into a managed Pi extension file, leaving an
 * already-current file untouched.
 *
 * Why: Pi-Bolt compiles the managed extensions and reports a rewritten file as
 * changed since it was compiled even when the bytes are identical, so a
 * byte-equal target must keep its mtime (issue #143).
 */
export function writeManagedPiExtension(path: string, source: string): ManagedPiExtensionWrite {
  const existing = readManagedPiExtension(path)
  // A missing or unreadable target is Orca's to create, matching the marker check alone.
  if (existing !== null) {
    if (!existing.includes(ORCA_MANAGED_PI_EXTENSION_MARKER)) {
      return 'skipped-user-owned'
    }
    if (existing === source) {
      return 'unchanged'
    }
  }

  try {
    writeFileSync(path, source)
    return 'written'
  } catch {
    return 'failed'
  }
}

function readManagedPiExtension(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
