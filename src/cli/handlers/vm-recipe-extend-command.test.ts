import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../../shared/ephemeral-vm-recipes'
import { VM_HANDLERS } from './vm'

const ownedDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-extend-cmd-'))
  ownedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  process.exitCode = undefined
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

const EXTENDED_RESULT = recipeResult({
  provider: 'example',
  resourceId: 'res-1',
  releaseAt: '2026-10-13T07:00:00Z',
  lifetimeSeconds: 57600
})

const ORCA_YAML = [
  'environmentRecipes:',
  '  - id: cloud-sandbox',
  '    name: Cloud Sandbox',
  '    create: ./create.sh',
  '    extend: ./extend.sh',
  '    extendDurations:',
  '      - 4h',
  ''
].join('\n')

/** A repo whose extend hook prints the extended result, plus the stored result beside it. */
function makeRepo(dir: string): void {
  writeFileSync(join(dir, 'orca.yaml'), ORCA_YAML)
  const script = join(dir, 'extend.sh')
  writeFileSync(script, `#!/bin/sh\ncat > ./extend-stdin.json\nprintf '%s' '${EXTENDED_RESULT}'\n`)
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'result.json'), STORED_RESULT)
}

function captureOutput(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  })
  return { stdout, stderr }
}

async function runExtend(
  cwd: string,
  flags: [string, string | boolean][],
  json = false
): Promise<{ stdout: string[]; stderr: string[] }> {
  const output = captureOutput()
  await VM_HANDLERS['vm recipe extend']({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only reads flags/cwd/json and never touches the runtime client.
    client: undefined as never,
    cwd,
    flags: new Map(flags),
    json
  })
  return output
}

describe('orca vm recipe extend', () => {
  it('resolves a relative --repo-path and --recipe-result against the invoking directory', async () => {
    // Why: over the SSH bridge cwd is the remote caller's directory, not process.cwd(). Before
    // the fix these two flags resolved against different roots in the same invocation.
    const caller = makeDir()
    const repo = join(caller, 'repo')
    mkdirSync(repo)
    makeRepo(repo)

    const { stdout, stderr } = await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['repo-path', './repo'],
      ['recipe-result', './repo/result.json'],
      ['lifetime', '4h']
    ])

    expect(stderr).toEqual([])
    expect(stdout.join('\n')).toContain('ok: true')
    expect(stdout.join('\n')).toContain('releaseAt: 2026-10-13T07:00:00Z')
  })

  it('reports a missing orca.yaml as a result instead of throwing ENOENT', async () => {
    const caller = makeDir()

    const { stdout, stderr } = await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['recipe-result', './result.json'],
      ['lifetime', '4h']
    ])

    expect(stdout).toEqual([])
    expect(stderr.join('\n')).toContain(`No orca.yaml found at ${join(caller, 'orca.yaml')}.`)
    expect(stderr.join('\n')).toContain('ok: false')
    expect(process.exitCode).toBe(1)
  })

  it('sends a text-mode failure to stderr so stdout stays consumable', async () => {
    const caller = makeDir()
    makeRepo(caller)

    const { stdout, stderr } = await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['recipe-result', './result.json'],
      ['lifetime', '8h']
    ])

    expect(stdout).toEqual([])
    expect(stderr.join('\n')).toContain('does not offer the lifetime "8h"')
    expect(process.exitCode).toBe(1)
  })

  it('writes the updated result for the destroy hook, mode 0600', async () => {
    const caller = makeDir()
    makeRepo(caller)

    const { stdout } = await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['recipe-result', './result.json'],
      ['lifetime', '4h'],
      ['write-result', './extended.json']
    ])

    const extendedPath = join(caller, 'extended.json')
    expect(stdout.join('\n')).toContain(`result: ${extendedPath} (mode 0600)`)
    // Why not the JSON: the file is what the hook reads, and printing it would put the
    // connection back on stdout.
    expect(stdout.join('\n')).not.toContain('"connection"')
    if (process.platform !== 'win32') {
      expect(statSync(extendedPath).mode & 0o777).toBe(0o600)
    }
    const parsed = parseEphemeralVmRecipeResult(readFileSync(extendedPath, 'utf8'))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.result.schemaVersion).toBe(1)
  })

  it('replaces the stored result in place when asked to', async () => {
    // Why: the second extend used to run against the stale lease, because nothing wrote
    // the new deadline back.
    const caller = makeDir()
    makeRepo(caller)

    await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['recipe-result', './result.json'],
      ['lifetime', '4h'],
      ['write-result', './result.json']
    ])

    expect(readFileSync(join(caller, 'result.json'), 'utf8')).toContain('2026-10-13T07:00:00Z')
  })

  it('leaves the stored result alone when the extend fails', async () => {
    const caller = makeDir()
    makeRepo(caller)
    const before = readFileSync(join(caller, 'result.json'), 'utf8')

    await runExtend(caller, [
      ['recipe-id', 'cloud-sandbox'],
      ['recipe-result', './result.json'],
      ['lifetime', '8h'],
      ['write-result', './result.json']
    ])

    expect(readFileSync(join(caller, 'result.json'), 'utf8')).toBe(before)
    expect(existsSync(join(caller, 'result.json'))).toBe(true)
  })

  it('keeps --json machine-readable on stdout with no extra warning for a connection-free payload', async () => {
    const caller = makeDir()
    makeRepo(caller)

    const { stdout, stderr } = await runExtend(
      caller,
      [
        ['recipe-id', 'cloud-sandbox'],
        ['recipe-result', './result.json'],
        ['lifetime', '4h']
      ],
      true
    )

    expect(stderr).toEqual([])
    const payload: unknown = JSON.parse(stdout.join('\n'))
    expect(payload).toMatchObject({ ok: true, releaseAt: '2026-10-13T07:00:00Z' })
  })
})
