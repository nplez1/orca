import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../shared/ephemeral-vm-recipes'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import {
  extendEphemeralVmRecipeFromFile,
  formatExtendEphemeralVmRecipeResult
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
