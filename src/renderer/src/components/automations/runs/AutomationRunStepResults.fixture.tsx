import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AutomationStepResult } from '../../../../../shared/automations/steps/automation-step-results'
import { AutomationRunStepResults } from './AutomationRunStepResults'

const base: AutomationStepResult = {
  stepId: 'triage',
  kind: 'script',
  script: 'scripts/triage.sh',
  args: ['--label', 'bug'],
  contentHash: '9f2c4a1e0b7d3c55e1f08a2b6c4d9e7f1a3b5c7d9e0f2a4b6c8d0e1f3a5b7c9d',
  outcome: 'succeeded',
  exitCode: 0,
  output: 'Found 3 issues: #12 #40 #41',
  outputTruncated: false,
  error: null,
  startedAt: 0,
  completedAt: 2300,
  durationMs: 2300
}

export const mixed = defineFixture({
  width: 600,
  render: () => (
    <div className="bg-background p-4">
      <AutomationRunStepResults
        results={[
          base,
          {
            ...base,
            stepId: 'report',
            script: 'scripts/report.sh',
            args: undefined,
            outcome: 'cut_off',
            exitCode: null,
            output: 'collecting…\nHook timed out after 60000ms.',
            durationMs: 60_000
          },
          {
            ...base,
            stepId: 'lint',
            script: 'scripts/lint.sh',
            args: undefined,
            outcome: 'unapproved',
            exitCode: null,
            output: '',
            reviewContent: '#!/bin/sh\npnpm lint\n'
          }
        ]}
        canReview={(result) => result.outcome === 'unapproved'}
        onReview={() => {}}
      />
    </div>
  )
})
