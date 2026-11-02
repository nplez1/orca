import { execFile, execFileSync } from 'node:child_process'
import { parseUtcLstart, psUtcEnvironment } from '../../shared/ps-lstart-time'

const PS_IDENTITY_TIMEOUT_MS = 2_000

export type ProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

const psIdentityArgs = (pid: number): string[] => [
  '-p',
  String(pid),
  '-o',
  'lstart=',
  '-o',
  'command='
]

function parsePsProcessIdentity(output: string): ProcessIdentity {
  // BSD ps formats lstart as a fixed-width 24-character timestamp.
  const startedAtMs = parseUtcLstart(output.slice(0, 24))
  return {
    commandLine: output.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  }
}

export function getPsProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const output = execFileSync('ps', psIdentityArgs(pid), {
      encoding: 'utf8',
      timeout: PS_IDENTITY_TIMEOUT_MS,
      env: psUtcEnvironment()
    })
    return parsePsProcessIdentity(output)
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        psIdentityArgs(pid),
        {
          encoding: 'utf8',
          env: psUtcEnvironment(),
          timeout: PS_IDENTITY_TIMEOUT_MS
        },
        (error, output) => {
          if (error) {
            reject(error)
            return
          }
          resolve(output)
        }
      )
    })
    return parsePsProcessIdentity(stdout)
  } catch {
    return null
  }
}
