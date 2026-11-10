import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'

const tempDirs: string[] = []

/** Removes every directory `makeDir` created; call from an `afterEach` in each suite that uses it. */
export function cleanupTempDirs(): void {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

export function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

export function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}
