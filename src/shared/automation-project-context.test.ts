import { describe, expect, it } from 'vitest'
import type { Automation } from './automations-types'
import {
  AUTOMATION_PROJECT_CONTEXT_MARKER,
  composeAutomationRunPrompt,
  formatAutomationProjectContext,
  getAutomationProjectContext
} from './automation-project-context'

const REPO = { id: 'repo-1', displayName: 'orca', path: '/work/orca' }

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Nightly review',
    prompt: 'Review open changes',
    precheck: null,
    agentId: 'codex',
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: 'ssh:ssh-target-1',
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      path: '/work/orca'
    },
    sourceContext: null,
    projectId: 'legacy-repo-1',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-target-1',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('automation project context', () => {
  it('reads the host-qualified project, not the legacy repo-id field', () => {
    const context = getAutomationProjectContext(automation(), REPO)

    expect(context).toEqual({
      projectId: 'project-1',
      projectName: 'orca',
      repoId: 'repo-1',
      hostId: 'ssh:ssh-target-1',
      path: '/work/orca',
      taskSource: null
    })
  })

  it('falls back to the legacy project id and the repo for a pre-host-context record', () => {
    const context = getAutomationProjectContext(
      automation({ runContext: null, sourceContext: undefined }),
      REPO
    )

    expect(context).toEqual({
      projectId: 'legacy-repo-1',
      projectName: 'orca',
      repoId: 'repo-1',
      hostId: null,
      path: '/work/orca',
      taskSource: null
    })
  })

  it('has no context when the record names no project and no repo is known', () => {
    expect(
      getAutomationProjectContext(automation({ runContext: null, projectId: '' }), null)
    ).toBeNull()
  })

  it('carries the pinned task source, including its account', () => {
    const context = getAutomationProjectContext(
      automation({
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'github:stablyai/orca',
          hostId: 'runtime:gpu',
          projectHostSetupId: null,
          repoId: 'repo-1',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'orca' },
          accountLabel: 'gpu-bot'
        }
      }),
      REPO
    )

    expect(context?.taskSource).toEqual({
      provider: 'github',
      projectId: 'github:stablyai/orca',
      accountLabel: 'gpu-bot'
    })
    expect(formatAutomationProjectContext(context!)).toBe(
      [
        AUTOMATION_PROJECT_CONTEXT_MARKER,
        'Project: orca (project-1)',
        'Host: ssh:ssh-target-1',
        "Project root: /work/orca (shared checkout, not necessarily this run's workspace)",
        'Task source: github stablyai/orca (account gpu-bot)'
      ].join('\n')
    )
  })

  it('omits the host, path, and task source lines it has no value for', () => {
    const context = getAutomationProjectContext(
      automation({ runContext: null, sourceContext: undefined, projectId: 'project-9' }),
      null
    )

    expect(formatAutomationProjectContext(context!)).toBe(
      [AUTOMATION_PROJECT_CONTEXT_MARKER, 'Project: project-9'].join('\n')
    )
  })
})

describe('composeAutomationRunPrompt', () => {
  it('prefixes the saved prompt with the project block', () => {
    const composed = composeAutomationRunPrompt(automation(), REPO)

    expect(composed).toBe(
      [
        AUTOMATION_PROJECT_CONTEXT_MARKER,
        'Project: orca (project-1)',
        'Host: ssh:ssh-target-1',
        "Project root: /work/orca (shared checkout, not necessarily this run's workspace)",
        '',
        'Review open changes'
      ].join('\n')
    )
  })

  it('leaves an automation with no project byte-identical', () => {
    const record = automation({ runContext: null, projectId: '', prompt: '  keep my spacing  ' })

    expect(composeAutomationRunPrompt(record, null)).toBe('  keep my spacing  ')
  })

  it('does not nest a block that is already there', () => {
    const once = composeAutomationRunPrompt(automation(), REPO)

    expect(composeAutomationRunPrompt(automation({ prompt: once }), REPO)).toBe(once)
  })

  it('leaves a blank prompt blank, so the launch stays bare', () => {
    expect(composeAutomationRunPrompt(automation({ prompt: '   ' }), REPO)).toBe('   ')
  })

  it('never rewrites the stored prompt', () => {
    const record = automation()

    composeAutomationRunPrompt(record, REPO)

    expect(record.prompt).toBe('Review open changes')
  })
})
