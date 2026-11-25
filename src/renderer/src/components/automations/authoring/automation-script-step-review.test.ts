import { describe, expect, it } from 'vitest'
import type { AutomationStepResult } from '../../../../../shared/automations/steps/automation-step-results'
import { reviewAutomationScriptStep } from './automation-script-step-review'

const result: AutomationStepResult = {
  stepId: 'check',
  kind: 'script',
  script: 'scripts/check.sh',
  args: ['--delete', 'build'],
  contentHash: 'hash',
  outcome: 'unapproved',
  exitCode: null,
  output: '',
  outputTruncated: false,
  error: null,
  startedAt: 0,
  completedAt: 0,
  durationMs: 0,
  reviewContent: '#!/bin/sh\nrm -rf "$2"\n'
}
const automation = { id: 'a', projectId: 'repo', runContext: null }

/** A state whose repo is trusted repo-wide and has approved hooks: what the hook prompt skips on. */
function harness(answer: 'run' | 'trust' | 'skip') {
  const shown: Record<string, unknown>[] = []
  const approvals: unknown[] = []
  const state = {
    repos: [],
    projectGroups: [],
    trustedOrcaHooks: { repo: { all: { approvedAt: 1 } } },
    openModal: (_modal: string, data: Record<string, unknown> = {}) => {
      shown.push(data)
      if (typeof data.onResolve === 'function') {
        data.onResolve(answer)
      }
    }
  }
  const approve = async (request: unknown) => {
    approvals.push(request)
  }
  return {
    shown,
    approvals,
    run: () => reviewAutomationScriptStep(automation, 'r', result, { state, approve })
  }
}

describe('reviewing a refused script step', () => {
  it('always shows the path and exact arguments, even in a repo trusted repo-wide', async () => {
    const { shown, approvals, run } = harness('run')
    expect(await run()).toBe(true)
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({
      scriptStep: { script: 'scripts/check.sh', args: ['--delete', 'build'] },
      scriptContent: result.reviewContent,
      repoWideTrust: false
    })
    expect(approvals).toEqual([{ automationId: 'a', runId: 'r', stepId: 'check' }])
  })

  it('approves nothing unless the user chose to approve this step', async () => {
    for (const answer of ['skip', 'trust'] as const) {
      const { approvals, run } = harness(answer)
      expect(await run()).toBe(false)
      expect(approvals).toEqual([])
    }
  })
})
