import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AutomationScriptStepsFields } from './AutomationScriptStepsFields'
import type { AutomationDraft } from './AutomationEditorDialog'

const DRAFT: AutomationDraft = {
  name: 'Nightly triage',
  prompt: 'Triage the issues the script found',
  agentId: 'claude',
  surface: 'terminal',
  extraAgentArgs: '',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: '',
  baseBranch: 'main',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '',
  preset: 'daily',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '',
  scheduleWarning: null,
  bot: null
}

function Steps({ initial }: { initial: AutomationDraft }): React.JSX.Element {
  const [draft, setDraft] = useState(initial)
  return (
    <div className="bg-background p-4">
      <AutomationScriptStepsFields
        draft={draft}
        disabled={false}
        pickerTriggerClassName=""
        onDraftChange={(update) => setDraft(update)}
      />
    </div>
  )
}

export const empty = defineFixture({ width: 360, render: () => <Steps initial={DRAFT} /> })

export const scriptThenAgent = defineFixture({
  width: 360,
  render: () => (
    <Steps
      initial={{
        ...DRAFT,
        scriptSteps: [
          {
            key: 'triage',
            id: 'triage',
            script: 'scripts/triage.sh',
            args: '--label bug',
            timeoutSeconds: '120',
            onFailure: 'stop'
          },
          {
            key: 'report',
            id: 'report',
            script: 'scripts/report.sh',
            args: '',
            timeoutSeconds: '60',
            onFailure: 'continue'
          }
        ],
        runAgentStep: true
      }}
    />
  )
})

export const shellBody = defineFixture({
  width: 360,
  render: () => (
    <Steps
      initial={{
        ...DRAFT,
        scriptSteps: [
          {
            key: 'triage',
            id: 'triage',
            script: 'npm ci && npm test',
            args: '',
            timeoutSeconds: '120',
            onFailure: 'stop'
          }
        ]
      }}
    />
  )
})
