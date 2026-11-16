import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

const tmpRoots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await removeTempDirs(tmpRoots.splice(0))
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-process-'))
  tmpRoots.push(root)
  return root
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runRecipeCommand', () => {
  it('absorbs a stdin write failure so a shell that exits early cannot crash the host', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      stdin: '{"kind":"destroy"}',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seam is typed `typeof spawn`; the fake only has to produce a child whose stdio the case drives.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double only needs the spawn seam the process under test calls.
      spawnCommand: vi.fn(() => child) as never
    })

    // Why synthetic: emitting `error` on a stream with no listener throws, which is the same
    // uncaught exception a real EPIPE produces during the end() write. Awaiting a real failing
    // write would report it as an unhandled error rather than a clean assertion failure.
    await Promise.resolve()
    expect(() =>
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).not.toThrow()

    child.emit('close', 9, null)
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 9 })
  })

  it.skipIf(process.platform === 'win32')(
    'kills grandchildren of a recipe that outlives its timeout',
    async () => {
      const repoPath = makeRepo()
      const sleeperPath = join(repoPath, 'sleeper.js')
      const spawnerPath = join(repoPath, 'spawner.js')
      const pidPath = join(repoPath, 'grandchild.pid')
      writeFileSync(sleeperPath, 'setInterval(() => {}, 1000)\n')
      writeFileSync(
        spawnerPath,
        [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, [${JSON.stringify(sleeperPath)}], { stdio: 'ignore' })`,
          `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
          "process.stderr.write('ready\\n')",
          'setInterval(() => {}, 1000)'
        ].join('\n')
      )
      // Fake only the deadline timers so the timeout fires after the grandchild exists, even under load.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const ready = Promise.withResolvers<void>()

      const resultPromise = runRecipeCommand({
        command: nodeCommand(spawnerPath),
        repoPath,
        mode: 'create',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath },
        timeoutMs: 1_000,
        onStderr: (chunk) => {
          if (chunk.includes('ready')) {
            ready.resolve()
          }
        }
      })
      await ready.promise
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await resultPromise
      vi.useRealTimers()

      expect(result).toMatchObject({ timedOut: true })
      expect(result).not.toHaveProperty('aborted')
      const grandchildPid = Number(readFileSync(pidPath, 'utf8'))
      await vi.waitFor(() => expect(isAlive(grandchildPid)).toBe(false), { timeout: 2_000 })
    },
    10_000
  )
})
