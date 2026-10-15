import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_AUTHORING_RULES,
  automationAuthoringSessionTitle,
  buildAutomationAuthoringBrief
} from './automation-authoring-brief'

const BASE = {
  mode: 'create' as const,
  description: 'Every day at 7am pull main, set up and build.',
  projectName: 'orca',
  workspaceLabel: 'nplez1/main',
  hostLabel: 'This Mac',
  hostKind: 'local' as const,
  platform: 'darwin' as const,
  timezone: 'Europe/London'
}

describe('buildAutomationAuthoringBrief', () => {
  it('carries the whole imperative-first policy', () => {
    const brief = buildAutomationAuthoringBrief(BASE)
    for (const rule of AUTOMATION_AUTHORING_RULES) {
      expect(brief).toContain(rule)
    }
    expect(brief).toContain('Interview before proposing.')
  })

  it("states the target host's shell so the commands it writes are runnable", () => {
    expect(buildAutomationAuthoringBrief(BASE)).toContain('run under `/bin/sh` on darwin')
    expect(buildAutomationAuthoringBrief({ ...BASE, platform: 'win32' })).toContain('cmd.exe')
    expect(
      buildAutomationAuthoringBrief({ ...BASE, hostKind: 'remote', platform: 'unknown' })
    ).toContain('platform is not known from here')
  })

  it('names the CLI verb and the step shapes it has to emit', () => {
    const brief = buildAutomationAuthoringBrief(BASE)
    expect(brief).toContain('orca automations create --name')
    expect(brief).toContain('--steps-json')
    expect(brief).toContain('"kind":"script"')
    expect(brief).toContain('$ORCA_CLI_COMMAND')
    // The create flow must not have the agent fill in a form instead.
    expect(brief).toContain('Do not fill in any form')
  })

  it('carries the user description and the context verbatim', () => {
    const brief = buildAutomationAuthoringBrief(BASE)
    expect(brief).toContain(BASE.description)
    expect(brief).toContain('orca')
    expect(brief).toContain('nplez1/main')
    expect(brief).toContain('"This Mac" — this computer')
    expect(brief).toContain('Europe/London')
  })

  it('includes the current plan when the session is changing one', () => {
    const brief = buildAutomationAuthoringBrief({
      ...BASE,
      mode: 'edit',
      existing: {
        id: 'automation-9',
        name: 'Daily latest build',
        schedule: 'Daily at 7:00 AM',
        steps: [{ kind: 'script', command: 'pnpm build', timeoutSeconds: 900, onFailure: 'stop' }]
      }
    })
    expect(brief).toContain('orca automations edit <id>')
    expect(brief).toContain('automation-9')
    expect(brief).toContain('"command": "pnpm build"')
    expect(brief).toContain('1 script step')
    expect(brief).toContain('Do not create a second automation')
  })
})

describe('automationAuthoringSessionTitle', () => {
  it('names an edit session after the automation and a create session by intent', () => {
    expect(automationAuthoringSessionTitle({ mode: 'edit', name: 'Nightly audit' })).toBe(
      'Automation: Nightly audit'
    )
    expect(automationAuthoringSessionTitle({ mode: 'create', name: null })).toBe('New automation')
  })
})
