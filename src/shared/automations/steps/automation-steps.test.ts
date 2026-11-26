import { describe, expect, it } from 'vitest'
import { AutomationSteps } from '../../rpc-contract/automations/automation-steps-params'
import { automationScriptStepCommand } from './automation-script-step-command'
import {
  AutomationStepsError,
  parseAutomationStepsForWrite,
  resolveAutomationSteps,
  validateAutomationSteps
} from './automation-steps'

const step = (fields: Record<string, unknown>) => [
  { kind: 'script', id: 'triage', script: 'scripts/triage.sh', timeoutSeconds: 5, ...fields }
]

const refusal = (value: unknown) => {
  const parsed = validateAutomationSteps(value)
  return parsed.ok ? null : parsed.code
}

describe('automation steps: the legacy record is the one-step agent case', () => {
  it('reads a prompt-only record as one agent step and writes it back unchanged', () => {
    const resolved = resolveAutomationSteps({ prompt: 'Triage the inbox', agentId: 'claude' })
    expect(resolved.ok && resolved.resolved).toEqual([
      { kind: 'agent', id: 'agent', prompt: 'Triage the inbox', agentId: 'claude' }
    ])
    // Storing nothing keeps a legacy record byte-identical, which an older host also reads.
    expect(parseAutomationStepsForWrite([{ kind: 'agent', id: 'agent' }])).toBeUndefined()
  })
})

describe('automation step validation', () => {
  it('refuses paths that leave the project or are not a plain file name', () => {
    for (const script of ['../x.sh', 'a/../x.sh', '/abs.sh', '-x.sh', 'a//x.sh', 'scripts/', '']) {
      expect(refusal(step({ script })), script).toBe('script_step_path_invalid')
    }
    for (const script of ['npm ci\nnpm test', 'npm test', 'a.sh;rm -rf ~']) {
      expect(refusal(step({ script })), script).toMatch(/script_step_(shell_body|path_invalid)/)
    }
    expect(refusal(step({ script: './scripts/triage.sh' }))).toBeNull()
  })

  it('refuses arguments cmd.exe would expand or cannot quote', () => {
    for (const arg of ['"x', '%PATH%', '!x!', 'a\nb', 'a\u0000b']) {
      expect(refusal(step({ args: [arg] })), arg).toBe('script_step_args_invalid')
    }
    expect(refusal(step({ args: ['--label=bug', 'a/b.c', "it's"] }))).toBeNull()
  })

  it('refuses arguments with characters that display differently from what runs', () => {
    for (const arg of [
      'a\u202eb',
      'a\u2066b',
      'a\u200bb',
      'a\u2028b',
      'a\u2029b',
      'a\u0085b',
      'a\u009bb'
    ]) {
      expect(refusal(step({ args: [arg] })), JSON.stringify(arg)).toBe('script_step_args_invalid')
    }
    expect(refusal(step({ args: ['café', '日本'] }))).toBeNull()
  })

  it('never keeps a pin from a client write, only from this host’s own record', () => {
    const pinned = step({ approvedPin: 'forged' })
    expect(parseAutomationStepsForWrite(pinned)?.[0]).not.toHaveProperty('approvedPin')
    expect(AutomationSteps.parse(pinned)?.[0]).not.toHaveProperty('approvedPin')
    const stored = validateAutomationSteps(pinned, { keepApprovals: true })
    expect(stored.ok && stored.steps[0]).toHaveProperty('approvedPin', 'forged')
  })

  it('refuses a shell body at the RPC boundary with a typed write error', () => {
    expect(AutomationSteps.safeParse(step({ script: 'npm ci\nnpm test' })).success).toBe(false)
    expect(() => parseAutomationStepsForWrite(step({ script: 'npm ci\nnpm test' }))).toThrow(
      expect.objectContaining({ code: 'script_step_shell_body' })
    )
    expect(() => parseAutomationStepsForWrite(step({ script: 'a b' }))).toThrow(
      AutomationStepsError
    )
  })
})

describe('automationScriptStepCommand', () => {
  it('quotes the verified copy and every argument for bash', () => {
    expect(automationScriptStepCommand('/tmp/o step/run.sh', ["it's", '$HOME'], 'posix')).toEqual({
      ok: true,
      command: `'/tmp/o step/run.sh' 'it'\\''s' '$HOME'`
    })
  })

  it('has a WSL guest copy the original’s mode before running, since Windows cannot set it', () => {
    expect(
      automationScriptStepCommand('/home/u/r/.orca-step-1-run.sh', ['a b'], 'posix', {
        modeFrom: '/home/u/r/run.sh'
      })
    ).toEqual({
      ok: true,
      command:
        "{ chmod --reference='/home/u/r/run.sh' '/home/u/r/.orca-step-1-run.sh' 2>/dev/null || chmod u+x '/home/u/r/.orca-step-1-run.sh'; } && " +
        "chmod u-s,g-s,o-t '/home/u/r/.orca-step-1-run.sh' || { echo ORCA_STEP_COPY_MODE_FAILED >&2; exit 126; }; '/home/u/r/.orca-step-1-run.sh' 'a b'"
    })
  })

  it('gives cmd.exe only a file it runs as-is, never a PATHEXT lookup', () => {
    expect(automationScriptStepCommand('C:\\t\\run.cmd', ['a&b'], 'cmd')).toEqual({
      ok: true,
      command: '"C:\\t\\run.cmd" "a&b"'
    })
    expect(automationScriptStepCommand('C:\\t\\run.BAT', [], 'cmd').ok).toBe(true)
    expect(automationScriptStepCommand('C:\\t\\run', [], 'cmd').ok).toBe(false)
    expect(automationScriptStepCommand('C:\\t\\run.sh', [], 'cmd').ok).toBe(false)
    expect(automationScriptStepCommand('C:\\%TEMP%\\run.cmd', [], 'cmd').ok).toBe(false)
  })
})
