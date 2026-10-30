import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../shared/ephemeral-vm-recipes'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import {
  DEFAULT_EXTEND_TIMEOUT_MS,
  MAX_EXTEND_TIMEOUT_MS,
  describeSensitiveExtendResult,
  extendEphemeralVmRecipeFromFile,
  formatExtendEphemeralVmRecipeResult,
  resolveExtendTimeoutMs,
  writeEphemeralVmRecipeResultFile
} from './vm-recipe-extend'

const ownedDirs: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-extend-'))
  ownedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SSH_CONNECTION = {
  type: 'ssh' as const,
  projectRoot: '/workspace/repo',
  target: { label: 'box', host: 'box.example.com', port: 22, username: 'developer' }
}

function recipeResult(userData: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, connection: SSH_CONNECTION, userData })
}

const STORED_RESULT = recipeResult({
  provider: 'example',
  resourceId: 'res-1',
  releaseAt: '2026-10-13T03:00:00Z',
  lifetimeSeconds: 21600
})

function writeResultFile(repoPath: string, contents: string): string {
  const path = join(repoPath, 'result.json')
  writeFileSync(path, contents)
  return path
}

function recipe(overrides: Partial<OrcaVmRecipe> = {}): OrcaVmRecipe {
  return { id: 'cloud-sandbox', name: 'Cloud Sandbox', create: './create.sh', ...overrides }
}

/** Writes an extend script that records its stdin next to itself and prints `printed`. */
function writeExtendScript(repoPath: string, printed: string): string {
  const path = join(repoPath, 'extend.sh')
  writeFileSync(path, `#!/bin/sh\ncat > ./extend-stdin.json\nprintf '%s' '${printed}'\n`)
  chmodSync(path, 0o755)
  return path
}

describe('orca vm recipe extend', () => {
  it('refuses a lifetime the recipe does not offer, and names the ones it does', async () => {
    const repoPath = makeRepo()
    writeExtendScript(repoPath, STORED_RESULT)
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['1h', '4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '8h'
    })
    expect(result.ok).toBe(false)
    expect(result.offeredLifetimes).toEqual(['1h', '4h'])
    expect(result.error).toContain('does not offer the lifetime "8h"')
  })

  it('refuses a recipe that declares no extend hook rather than doing nothing quietly', async () => {
    const repoPath = makeRepo()
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe(),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4h'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not declare extend')
  })

  it('rejects a lifetime that is not a duration at all', async () => {
    const repoPath = makeRepo()
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: 'tomorrow'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('is not a duration')
  })

  it('rejects a stored result that is not a valid recipe result', async () => {
    const repoPath = makeRepo()
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, '{"schemaVersion":1}'),
      requestedLifetime: '4h'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Recipe result file is not valid')
  })

  it('reports a missing result file instead of throwing', async () => {
    const repoPath = makeRepo()
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: join(repoPath, 'absent.json'),
      requestedLifetime: '4h'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No recipe result file')
  })

  it('hands the hook the stored result and the requested lifetime, and reports the new deadline', async () => {
    const repoPath = makeRepo()
    const extended = recipeResult({
      provider: 'example',
      resourceId: 'res-1',
      releaseAt: '2026-10-13T07:00:00Z',
      lifetimeSeconds: 57600
    })
    writeExtendScript(repoPath, extended)
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4H'
    })

    expect(result.ok).toBe(true)
    // `4H` is canonicalized before it reaches the provider.
    expect(result.requestedLifetime).toBe('4h')
    expect(result.releaseAt).toBe('2026-10-13T07:00:00Z')

    const stdinPath = join(repoPath, 'extend-stdin.json')
    expect(existsSync(stdinPath)).toBe(true)
    const payload: unknown = JSON.parse(readFileSync(stdinPath, 'utf8'))
    expect(payload).toMatchObject({
      mode: 'extend',
      lifetime: '4h',
      recipeId: 'cloud-sandbox',
      recipeResult: { userData: { releaseAt: '2026-10-13T03:00:00Z' } }
    })
  })

  it('fails when the hook returns a result with no lifetime metadata', async () => {
    const repoPath = makeRepo()
    writeExtendScript(repoPath, recipeResult({ provider: 'example', resourceId: 'res-1' }))
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4h'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('no lifetime metadata')
  })

  it('fails when the hook returns a deadline it cannot read', async () => {
    const repoPath = makeRepo()
    writeExtendScript(
      repoPath,
      recipeResult({
        provider: 'example',
        resourceId: 'res-1',
        // An offsetless timestamp, which does not name an instant.
        releaseAt: '2026-10-13T03:26:41'
      })
    )
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './extend.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4h'
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('userData.releaseAt must be an RFC 3339 timestamp')
  })

  it('formats a failure with its remediation and a success with the new deadline', () => {
    const failed = formatExtendEphemeralVmRecipeResult({
      recipeId: 'cloud-sandbox',
      repoPath: '/repo',
      ok: false,
      error: 'Extend exited with code 1.',
      offeredLifetimes: ['1h', '4h']
    })
    expect(failed).toContain('ok: false')
    expect(failed).toContain('Extend exited with code 1.')
    expect(failed).toContain('offered lifetimes: 1h, 4h')

    const parsedStored = parseEphemeralVmRecipeResult(STORED_RESULT)
    expect(parsedStored.ok).toBe(true)
    const succeeded = formatExtendEphemeralVmRecipeResult({
      recipeId: 'cloud-sandbox',
      repoPath: '/repo',
      ok: true,
      requestedLifetime: '4h',
      releaseAt: '2026-10-13T07:00:00Z',
      ...(parsedStored.ok ? { recipeResult: parsedStored.result } : {})
    })
    expect(succeeded).toContain('releaseAt: 2026-10-13T07:00:00Z')
    // The result carries the connection, so it is never presented as safe to paste around.
    expect(succeeded).toContain('handle as sensitive')
  })
})

describe('orca vm recipe extend deadline', () => {
  it('stops the hook at the deadline it is given', async () => {
    const repoPath = makeRepo()
    const hangPath = join(repoPath, 'hang.sh')
    writeFileSync(hangPath, '#!/bin/sh\nexec sleep 30\n')
    chmodSync(hangPath, 0o755)

    // Why a monotonic clock: this is a hang guard on elapsed time, not a wall-clock reading.
    const startedAt = performance.now()
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: './hang.sh', extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4h',
      timeoutMs: 200
    })

    expect(result.ok).toBe(false)
    // Why the message and not the exit code: the hook was killed, so a bare "exit unknown" would leave
    // the caller unable to tell a refusal from a deadline — and the provider may already have acted.
    expect(result.error).toContain('did not finish within 200 ms')
    // Why this wording: extend is paid and not idempotent, so the advice must not be "extend again".
    expect(result.error).toContain('before extending again')
    expect(result.transcript).toBeDefined()
    expect(performance.now() - startedAt).toBeLessThan(10_000)
  })

  it('refuses a timeout that cannot be a deadline rather than ignoring it', () => {
    expect(resolveExtendTimeoutMs(undefined)).toEqual({
      ok: true,
      timeoutMs: DEFAULT_EXTEND_TIMEOUT_MS
    })
    expect(resolveExtendTimeoutMs(0)).toMatchObject({ ok: false })
    expect(resolveExtendTimeoutMs(Number.NaN)).toMatchObject({ ok: false })
    expect(resolveExtendTimeoutMs(1500.5)).toMatchObject({ ok: false })
    expect(resolveExtendTimeoutMs(MAX_EXTEND_TIMEOUT_MS + 1)).toMatchObject({ ok: false })
  })

  it('reports an unbounded --timeout-ms without running the hook', async () => {
    const repoPath = makeRepo()
    const script = writeExtendScript(repoPath, STORED_RESULT)
    const result = await extendEphemeralVmRecipeFromFile({
      repoPath,
      recipe: recipe({ extend: script, extendDurations: ['4h'] }),
      recipeResultPath: writeResultFile(repoPath, STORED_RESULT),
      requestedLifetime: '4h',
      timeoutMs: -1
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('--timeout-ms')
    expect(existsSync(join(repoPath, 'extend-stdin.json'))).toBe(false)
  })
})

describe('extend result sensitivity', () => {
  const parsed = parseEphemeralVmRecipeResult(STORED_RESULT)
  if (!parsed.ok) {
    throw new Error('fixture must parse')
  }

  it('stays quiet about a result that carries no pairing code', () => {
    expect(
      describeSensitiveExtendResult({
        recipeId: 'cloud-sandbox',
        repoPath: '/repo',
        ok: true,
        recipeResult: parsed.result
      })
    ).toBeNull()
  })

  it('warns when the result carries a pairing code', () => {
    // Why: --json prints the connection verbatim, and text mode's inline warning is not printed
    // there, so the warning has to come from this check.
    expect(
      describeSensitiveExtendResult({
        recipeId: 'cloud-sandbox',
        repoPath: '/repo',
        ok: true,
        recipeResult: {
          schemaVersion: 1,
          connection: {
            type: 'orca-server',
            pairingCode: 'orca://pair?code=abc',
            projectRoot: '/workspace/repo'
          }
        }
      })
    ).toContain('pairing code')
  })
})

describe('writeEphemeralVmRecipeResultFile', () => {
  it('publishes the result at mode 0600 without hardening the directory', () => {
    const dir = makeRepo()
    chmodSync(dir, 0o755)
    const parsed = parseEphemeralVmRecipeResult(STORED_RESULT)
    if (!parsed.ok) {
      throw new Error('fixture must parse')
    }
    const target = join(dir, 'extended.json')

    expect(writeEphemeralVmRecipeResultFile(target, parsed.result)).toEqual({
      written: true,
      path: target,
      // Windows depends on whether the security addon resolved, so only POSIX has one answer.
      restricted: expect.any(Boolean)
    })

    expect(statSync(target).size).toBeGreaterThan(0)
    if (process.platform !== 'win32') {
      expect(statSync(target, { bigint: false }).mode & 0o777).toBe(0o600)
      // The shared secure-write helpers chmod the parent to 0700; that would silently lock down
      // the repo directory a caller writes into, so this write must leave it alone.
      expect(statSync(dir).mode & 0o777).toBe(0o755)
    }
  })

  it('reports an unwritable target instead of throwing, so the result can still be reported', () => {
    const dir = makeRepo()
    const parsed = parseEphemeralVmRecipeResult(STORED_RESULT)
    if (!parsed.ok) {
      throw new Error('fixture must parse')
    }

    const failure = writeEphemeralVmRecipeResultFile(join(dir, 'absent', 'x.json'), parsed.result)

    expect(failure).toMatchObject({ written: false })
    expect(existsSync(join(dir, 'absent'))).toBe(false)
  })
})
