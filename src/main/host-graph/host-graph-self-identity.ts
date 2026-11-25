import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { loadOrCreateE2EEKeypair } from '../runtime/rpc/server/pairing/e2ee-keypair'
import { formatHostKeyFingerprint } from '../ssh/host-keys/ssh-known-hosts'
import type { HostGraphMachineRef } from '../../shared/host-graph/host-graph-contract'

/**
 * This machine's own identity in the graph.
 *
 * Why it needs one at all: a peer reports this machine by the pairing key *it* recorded, so a host that
 * cannot name itself cannot recognise its own row and would list itself in the fleet it just asked
 * about. Both keys are ones this machine holds, never a route to it.
 */

/** Exactly the derivation `publicRuntimeEnvironmentWithHostKey` publishes, so both sides agree. */
export function orcaHostKeyOf(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 32)
}

/** `SHA256:...` of the raw key blob, which is what `ssh-host-key-store` records for a peer. */
export function sshHostKeyFingerprintOf(publicKeyLine: string): string | undefined {
  const blob = publicKeyLine.trim().split(/\s+/)[1]
  if (!blob) {
    return undefined
  }
  const decoded = Buffer.from(blob, 'base64')
  if (decoded.length === 0) {
    return undefined
  }
  return formatHostKeyFingerprint(createHash('sha256').update(decoded).digest('base64'))
}

export function machineRefOf(sources: {
  orcaPublicKeyB64?: string
  sshPublicKeyLines?: readonly string[]
}): HostGraphMachineRef {
  const sshHostKeys = [
    ...new Set(
      (sources.sshPublicKeyLines ?? [])
        .map((line) => sshHostKeyFingerprintOf(line))
        .filter((fingerprint): fingerprint is string => fingerprint !== undefined)
    )
  ].sort()
  return {
    ...(sources.orcaPublicKeyB64 ? { orcaHostKey: orcaHostKeyOf(sources.orcaPublicKeyB64) } : {}),
    ...(sshHostKeys.length > 0 ? { sshHostKeys } : {})
  }
}

/**
 * Why every read is guarded separately: a Windows box has no sshd keys and a locked keyring has no
 * pairing key, and either must leave this machine describable by whatever it does have.
 */
export function readSelfMachineRef(userDataPath: string): HostGraphMachineRef {
  return machineRefOf({
    orcaPublicKeyB64: readPairedPublicKey(userDataPath),
    sshPublicKeyLines: readOwnSshPublicKeys()
  })
}

export function selfLabel(): string {
  return hostname()
}

function readPairedPublicKey(userDataPath: string): string | undefined {
  try {
    return loadOrCreateE2EEKeypair(userDataPath).publicKeyB64
  } catch {
    return undefined
  }
}

function readOwnSshPublicKeys(): string[] {
  try {
    return readdirSync('/etc/ssh')
      .filter((name) => /^ssh_host_.+_key\.pub$/.test(name))
      .map((name) => readFileSync(join('/etc/ssh', name), 'utf-8'))
  } catch {
    return []
  }
}
