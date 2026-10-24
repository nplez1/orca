import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileCapture } from './exec-file-capture'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { GitCommandTimeoutError } from './git-command-timeout'
import { deadlineOverrunOf } from './stalled-deadline-kill'
import { gitStreamStdout } from './git-stream-stdout'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTimedGitFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-git-timeout-'))
  tempRoots.push(root)
  const binDir = path.join(root, 'bin')
  const cwd = path.join(root, 'repo')
  await mkdir(binDir)
  await mkdir(cwd)
  const script = path.join(binDir, 'git')
  await writeFile(
    script,
    `#!/usr/bin/env node
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function run() {
  if (process.env.ORCA_STUB_PROGRESSIVE === '1') {
    const remaining = Math.max(0, Number(process.env.ORCA_STUB_EXIT_AT_MS) - Date.now())
    const step = remaining / 3
    await sleep(step)
    process.stdout.write('one')
    await sleep(step)
    process.stdout.write('two')
    await sleep(step)
    process.stdout.write('three')
    return
  }
  await sleep(Number(process.env.ORCA_STUB_SLEEP_MS))
  process.stdout.write('done')
  if (process.env.ORCA_STUB_TOUCH_FILE) {
    require('node:fs').writeFileSync(process.env.ORCA_STUB_TOUCH_FILE, '')
  }
}
void run()
`
  )
  await chmod(script, 0o755)
  return {
    cwd,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }
  }
}

describe.skipIf(process.platform === 'win32')('git read timeout behavior', () => {
  // Why real time: a fake clock cannot reproduce a main thread that stops servicing the I/O
  // its deadline timers wait on — the exact shape of #155. `Atomics.wait` blocks this thread
  // without yielding to the loop, so the stall is a pure stall and costs no CPU.
  const stallCell = new Int32Array(new SharedArrayBuffer(4))
  function stallMainThread(stallMs: number, untilStubFinished?: string): void {
    const stalledAt = performance.now() + stallMs
    const giveUpAt = stalledAt + 10_000
    for (;;) {
      const stalled = performance.now() >= stalledAt
      const stubFinished = untilStubFinished === undefined || existsSync(untilStubFinished)
      if ((stalled && stubFinished) || performance.now() >= giveUpAt) {
        return
      }
      Atomics.wait(stallCell, 0, 0, 2)
    }
  }

  it('does not fail a command that finished while the main thread was stalled', async () => {
    const fixture = await createTimedGitFixture()
    // Why the sentinel: the stall has to outlast the deadline *and* the stub, on any machine.
    const stubFinished = path.join(fixture.cwd, 'stub-finished')
    const captured = execFileCapture('git', ['status'], {
      cwd: fixture.cwd,
      env: {
        ...fixture.env,
        ORCA_STUB_SLEEP_MS: '10',
        ORCA_STUB_TOUCH_FILE: stubFinished
      },
      encoding: 'utf-8',
      timeout: 60
    })
    stallMainThread(600, stubFinished)
    await expect(captured).resolves.toMatchObject({ stdout: 'done' })
  })

  it('still rejects a command running after the stall, tagged with the stall', async () => {
    const fixture = await createTimedGitFixture()
    const captured = execFileCapture('git', ['status'], {
      cwd: fixture.cwd,
      env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '10000' },
      encoding: 'utf-8',
      timeout: 60,
      createTimeoutError: () => new GitCommandTimeoutError(60)
    })
    stallMainThread(400)
    const error: unknown = await captured.then(
      () => null,
      (failure: unknown) => failure
    )
    expect(error).toBeInstanceOf(GitCommandTimeoutError)
    expect(deadlineOverrunOf(error) ?? 0).toBeGreaterThanOrEqual(300)
  })

  it('does not fail a streamed read that finished while the main thread was stalled', async () => {
    const fixture = await createTimedGitFixture()
    let output = ''
    const streamed = gitStreamStdout(['status'], {
      ...fixture,
      env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '10' },
      timeoutMsForTest: 1000,
      onStdout: (chunk) => {
        output += chunk
        stallMainThread(1600)
      }
    })
    await expect(streamed).resolves.toEqual({ stoppedEarly: false })
    expect(output).toBe('done')
  })

  it('allows a progressively streaming read that exits at 0.9 times the deadline', async () => {
    const fixture = await createTimedGitFixture()
    let output = ''
    await expect(
      gitStreamStdout(['status', '--porcelain=v2'], {
        ...fixture,
        env: {
          ...fixture.env,
          ORCA_STUB_PROGRESSIVE: '1',
          ORCA_STUB_EXIT_AT_MS: String(Date.now() + 900)
        },
        timeoutMsForTest: 1000,
        onStdout: (chunk) => {
          output += chunk
        }
      })
    ).resolves.toEqual({ stoppedEarly: false })
    expect(output).toBe('onetwothree')
  })

  it('rejects a silent read at 1.1 times the deadline with a typed error', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitExecFileAsync(['status', '--porcelain=v2'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it('times out a silent streaming read with the same typed error', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitStreamStdout(['status'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100,
        onStdout: () => {}
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it('applies the read default to binary blob reads', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitExecFileAsyncBuffer(['show', 'HEAD:file.bin'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it.each([['fetch'], ['checkout'], ['unrecognized-command']])(
    'does not default-timeout the fail-safe %s class',
    async (subcommand) => {
      const fixture = await createTimedGitFixture()
      await expect(
        gitExecFileAsync([subcommand], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
          timeoutMsForTest: 100
        })
      ).resolves.toMatchObject({ stdout: 'done' })
    }
  )
})

describe.skipIf(process.platform === 'win32' || process.env.ORCA_RUN_SLOW_GIT_SMOKE !== '1')(
  'slow git read timeout smoke',
  () => {
    it('allows a 90 second read and terminates a 130 second wedge', async () => {
      const fixture = await createTimedGitFixture()
      await expect(
        gitExecFileAsync(['status'], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '90000' }
        })
      ).resolves.toMatchObject({ stdout: 'done' })
      await expect(
        gitExecFileAsync(['status'], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '130000' }
        })
      ).rejects.toBeInstanceOf(GitCommandTimeoutError)
    }, 230_000)
  }
)
