import { execFileSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AutomationScriptStep } from '../../../shared/automations/steps/automation-steps'
import {
  normalizeAutomationStepResults,
  runAutomationScriptSteps
} from '../../../shared/automations/steps/automation-step-results'
import { automationScriptStepPin } from './script-step-pin'
import { runHookCommand } from '../../workspace-hooks/hooks'
import {
  automationScriptStepCommand,
  isCopyModeFailure
} from '../../../shared/automations/steps/automation-script-step-command'
import { createAutomationScriptStepExecutor } from './script-step-runner'

describe.skipIf(process.platform === 'win32')('automation script steps on this host', () => {
  let cwd: string
  const scripts: Record<string, string> = {
    'ok.sh': '#!/bin/sh\necho "hello from ok"\n',
    'fail.sh': '#!/bin/sh\necho partial\nexit 3\n',
    'reads.sh': '#!/bin/sh\necho "saw=$ORCA_STEP_FIRST_STDOUT exit=$ORCA_STEP_FIRST_EXIT"\n',
    // Exits 0 on SIGTERM: a stopped step must still be cut off, never succeeded (#19334).
    'trap.sh': "#!/bin/sh\ntrap 'exit 0' TERM\nsleep 30 &\nwait\n",
    'where.sh': '#!/bin/sh\ndirname "$0"\necho "$ORCA_AUTOMATION_STEP_SCRIPT"\n',
    'locked/run.sh': '#!/bin/sh\necho locked\n',
    'status.sh': '#!/bin/sh\ngit status --porcelain --untracked-files=all\necho ---\nls -a\n'
  }
  const repo: { path: string; kind: 'git' } = { path: '', kind: 'git' }

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-script-steps-'))
    repo.path = cwd
    await mkdir(join(cwd, 'locked'))
    for (const [name, content] of Object.entries(scripts)) {
      await writeFile(join(cwd, name), content)
      await chmod(join(cwd, name), 0o755)
    }
    // A repository with everything committed, so any copy Orca leaves visible shows in status.
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'scripts')
  })
  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  /** The pin a user's approval would write for this file, path and arguments. */
  const pinFor = (script: string, overrides: Partial<AutomationScriptStep>) =>
    Object.hasOwn(overrides, 'approvedPin') || !scripts[script]
      ? {}
      : {
          approvedPin: automationScriptStepPin(
            { script, args: overrides.args },
            Buffer.from(scripts[script])
          )
        }
  const step = (
    id: string,
    script: string,
    overrides: Partial<AutomationScriptStep> = {}
  ): AutomationScriptStep => ({
    kind: 'script',
    id,
    script,
    timeoutSeconds: 10,
    onFailure: 'stop',
    ...overrides,
    ...pinFor(script, overrides)
  })
  const run = (steps: AutomationScriptStep[]) =>
    runAutomationScriptSteps(
      steps,
      createAutomationScriptStepExecutor({ type: 'local', cwd, repo })
    )

  it('hands the first step’s stdout and exit code to the next step', async () => {
    const outcome = await run([step('first', 'ok.sh'), step('second', 'reads.sh')])
    expect(outcome.stoppedBy).toBeNull()
    expect(outcome.results.map((result) => result.outcome)).toEqual(['succeeded', 'succeeded'])
    expect(outcome.results[1]!.output).toBe('saw=hello from ok\n exit=0')
    expect(outcome.results[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(outcome.env.ORCA_STEP_SECOND_EXIT).toBe('0')
  })

  it('stops on a real exit code by default, and continues only when told to', async () => {
    const stopped = await run([step('first', 'fail.sh'), step('second', 'ok.sh')])
    expect(stopped.results).toHaveLength(1)
    expect(stopped.stoppedBy).toMatchObject({ outcome: 'failed', exitCode: 3 })

    const continued = await run([
      step('first', 'fail.sh', { onFailure: 'continue' }),
      step('second', 'ok.sh')
    ])
    expect(continued.stoppedBy).toBeNull()
    expect(continued.results.map((result) => result.outcome)).toEqual(['failed', 'succeeded'])
  })

  it('records a timed-out step that exits 0 on SIGTERM as cut off', async () => {
    const outcome = await run([step('first', 'trap.sh', { timeoutSeconds: 1 })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'cut_off', exitCode: null })
  })

  it('refuses unapproved or changed content even under continue, and never runs it', async () => {
    const outcome = await run([
      step('first', 'ok.sh', { onFailure: 'continue', approvedPin: 'stale' }),
      step('second', 'ok.sh')
    ])
    expect(outcome.results).toHaveLength(1)
    expect(outcome.stoppedBy).toMatchObject({
      outcome: 'unapproved',
      output: '',
      reviewContent: scripts['ok.sh']
    })
  })

  it('refuses a missing file as unverifiable rather than skipping it', async () => {
    const outcome = await run([step('first', 'missing.sh', { approvedPin: 'x' })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'unverifiable', contentHash: null })
  })

  it('needs approval again when the arguments of an approved script change', async () => {
    const approved = step('first', 'ok.sh')
    const outcome = await run([{ ...approved, args: ['--other'] }])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'unapproved' })
  })

  it('pins raw bytes: a leading newline that drops the shebang is a different script', async () => {
    const approvedPin = automationScriptStepPin(
      { script: 'ok.sh' },
      Buffer.from(`\n${scripts['ok.sh']}`)
    )
    const outcome = await run([step('first', 'ok.sh', { approvedPin })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'unapproved' })
  })

  it('refuses a symlink that resolves outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'orca-script-outside-'))
    await writeFile(join(outside, 'evil.sh'), scripts['ok.sh']!)
    await mkdir(join(cwd, 'links'), { recursive: true })
    await symlink(join(outside, 'evil.sh'), join(cwd, 'links', 'evil.sh'))
    const outcome = await run([step('first', 'links/evil.sh', { approvedPin: 'x' })])
    expect(outcome.stoppedBy).toMatchObject({ outcome: 'unverifiable' })
    expect(outcome.stoppedBy?.error).toContain('outside the project')
    await rm(outside, { recursive: true, force: true })
  })

  it('runs its verified copy beside the original, so the script’s own directory is unchanged', async () => {
    const outcome = await run([step('first', 'where.sh')])
    const root = await realpath(cwd)
    expect(outcome.results[0]!.output).toBe(`${root}\n${join(root, 'where.sh')}`)
  })

  it('removes the copy after success, failure and timeout', async () => {
    await run([step('first', 'ok.sh')])
    await run([step('first', 'fail.sh')])
    await run([step('first', 'trap.sh', { timeoutSeconds: 1 })])
    expect((await readdir(cwd)).filter((name) => name.startsWith('.orca-step-'))).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)(
    'refuses as unverifiable when the script’s directory takes no copy',
    async () => {
      await chmod(join(cwd, 'locked'), 0o555)
      try {
        const outcome = await run([step('first', 'locked/run.sh')])
        expect(outcome.stoppedBy).toMatchObject({ outcome: 'unverifiable' })
        expect(outcome.stoppedBy?.error).toContain('verified copy')
      } finally {
        await chmod(join(cwd, 'locked'), 0o755)
      }
    }
  )

  it('keeps its copy out of git status while the step runs', async () => {
    const outcome = await run([step('first', 'status.sh')])
    const [status, listing] = outcome.results[0]!.output.split('---')
    // The copy exists (ls shows it) yet git status does not list it.
    expect(listing).toMatch(/\.orca-step-[0-9a-f]{12}-status\.sh/)
    expect(status).not.toContain('.orca-step')
  })

  it('sweeps a stale copy left by a crash, but not one a running step may own', async () => {
    const stale = join(cwd, '.orca-step-aaaaaaaaaaaa-ok.sh')
    const fresh = join(cwd, '.orca-step-bbbbbbbbbbbb-ok.sh')
    await writeFile(stale, 'old')
    await writeFile(fresh, 'new')
    const longAgo = new Date('2020-01-01T00:00:00Z')
    await utimes(stale, longAgo, longAgo)
    await run([step('first', 'ok.sh')])
    await expect(stat(stale)).rejects.toThrow()
    await expect(stat(fresh)).resolves.toBeTruthy()
    await rm(fresh)
  })

  it('treats a copy the guest could not make runnable as never run, not as the script failing', async () => {
    const run = (modeFrom: string, copy: string) => {
      const command = automationScriptStepCommand(copy, ['x'], 'posix', { modeFrom })
      if (!command.ok) {
        throw new Error(command.error)
      }
      return runHookCommand({
        hookName: 'mode test',
        script: command.command,
        cwd,
        pathEnv: {},
        timeoutMs: 10_000
      })
    }
    const broken = await run(join(cwd, 'gone.sh'), join(cwd, 'also-gone.sh'))
    expect(broken).toMatchObject({ success: false, exitCode: 126 })
    expect(isCopyModeFailure({ exitCode: broken.exitCode, output: broken.output })).toBe(true)

    await writeFile(join(cwd, 'plain.sh'), '#!/bin/sh\necho "ran $1"\nexit 126\n')
    await chmod(join(cwd, 'plain.sh'), 0o644)
    const ran = await run(join(cwd, 'ok.sh'), join(cwd, 'plain.sh'))
    // The script's own 126 stays a failure of the script.
    expect(ran.output).toContain('ran x')
    expect(isCopyModeFailure({ exitCode: ran.exitCode, output: ran.output })).toBe(false)
  })

  it('persists results without the handoff stdout', async () => {
    const outcome = await run([step('first', 'ok.sh')])
    const [persisted] = normalizeAutomationStepResults(outcome.results)!
    expect(outcome.results[0]!.stdout).toBe('hello from ok\n')
    expect(persisted).not.toHaveProperty('stdout')
    expect(persisted).toMatchObject({ stepId: 'first', script: 'ok.sh', outcome: 'succeeded' })
  })
})
