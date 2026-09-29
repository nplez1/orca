// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckJob, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { CheckFailureSummary } from './CheckFailureSummary'
import { CheckStageTree } from './CheckStageTree'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => content
}))

vi.mock('@/components/right-sidebar/source-control-fix-split-button', () => ({
  SourceControlFixSplitButton: () => null
}))

vi.mock('./check-run-details-fix-with-ai', () => ({
  useCheckRunDetailsFixWithAI: () => ({
    canFixWithAI: false,
    disabledReason: null,
    isFixing: false,
    fixPrompt: '',
    repoId: null,
    connectionId: null,
    launchPlatform: null,
    savedAgentId: null,
    savedCommandInputTemplate: null,
    savedAgentArgs: [],
    saveLaunchActionDefault: vi.fn(),
    openSourceControlAiSettings: vi.fn(),
    fixWithAI: vi.fn()
  })
}))

const openSettingsTarget = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openSettingsTarget })
}))

afterEach(cleanup)

const jenkinsJob: PRCheckJob = {
  id: 12,
  name: '#12',
  status: 'completed',
  conclusion: 'failure',
  startedAt: null,
  completedAt: null,
  url: null,
  logTail: null,
  stepRendering: 'all',
  steps: [
    {
      name: 'Checkout',
      status: 'completed',
      conclusion: 'success',
      startedAt: null,
      completedAt: null,
      children: [
        {
          name: 'Git',
          status: 'completed',
          conclusion: 'success',
          startedAt: null,
          completedAt: null
        }
      ]
    },
    {
      name: 'Test',
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null,
      errorMessage: 'script returned exit code 1',
      children: [
        {
          name: 'Shell Script',
          status: 'completed',
          conclusion: 'failure',
          startedAt: null,
          completedAt: null,
          errorMessage: 'script returned exit code 1'
        }
      ]
    }
  ]
}

const jenkinsDetails: PRCheckRunDetails = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/12/',
  detailsUrl: 'https://ci.example.com/job/team/job/repo/12/',
  startedAt: null,
  completedAt: null,
  title: 'team » repo » main #12',
  summary: null,
  text: null,
  annotations: [],
  jobs: [jenkinsJob],
  build: {
    number: '12',
    queuedMs: null,
    estimatedDurationMs: null,
    triggeredBy: null,
    parameters: [],
    commits: []
  }
}

describe('CheckStageTree', () => {
  it('opens a failed stage onto its steps and keeps a passing stage closed', () => {
    render(<CheckStageTree job={jenkinsJob} />)

    expect(screen.getByText('Test')).toBeTruthy()
    expect(screen.getByText('Shell Script')).toBeTruthy()
    expect(screen.getByText('Checkout')).toBeTruthy()
    // Checkout succeeded, so its steps stay behind the toggle until asked for.
    expect(screen.queryByText('Git')).toBeNull()
  })

  it('renders a large stage list with repeated names without key collisions', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const steps = Array.from({ length: 250 }, (_, index) => ({
        // Every fifth stage repeats a name, as a loop or parallel branch does; the Jenkins node id
        // is what keeps the React keys unique.
        id: `node-${index}`,
        name: index % 5 === 0 ? 'Deploy' : `Stage ${index}`,
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null
      }))
      render(<CheckStageTree job={{ ...jenkinsJob, steps }} />)

      expect(screen.getAllByText('Deploy')).toHaveLength(50)
      expect(screen.getByText('Stage 249')).toBeTruthy()
      expect(screen.getByText('Stage 3')).toBeTruthy()
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('CheckFailureSummary', () => {
  it('names the failing stage and its failure text', () => {
    render(<CheckFailureSummary details={jenkinsDetails} />)

    expect(screen.getByText('Failures')).toBeTruthy()
    expect(screen.getByText('Test')).toBeTruthy()
    expect(screen.getByText('script returned exit code 1')).toBeTruthy()
    expect(screen.queryByText('Checkout')).toBeNull()
  })

  it('renders nothing when every job and step passed', () => {
    const { container } = render(
      <CheckFailureSummary
        details={{
          ...jenkinsDetails,
          jobs: [{ ...jenkinsJob, conclusion: 'success', steps: [] }]
        }}
      />
    )

    expect(container.textContent).toBe('')
  })
})

describe('the Jenkins details panel', () => {
  it('drops the Output box when only the build title is present', () => {
    render(
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={{
            name: 'continuous-integration/jenkins/pr-merge',
            status: 'completed',
            conclusion: 'failure',
            url: null
          }}
          details={jenkinsDetails}
          loading={false}
          error={null}
          openUrl={null}
          worktreeId={null}
        />
      </TooltipProvider>
    )

    expect(screen.queryByText('Output')).toBeNull()
    expect(screen.getByText('Failures')).toBeTruthy()
  })

  it('offers a Jenkins settings link beside a configuration error', () => {
    openSettingsTarget.mockReset()
    render(
      <TooltipProvider>
        <CheckRunDetailsPanel
          check={{
            name: 'continuous-integration/jenkins/pr-merge',
            status: 'completed',
            conclusion: 'failure',
            url: null
          }}
          details={null}
          loading={false}
          error="Orca has no Jenkins server configured for https://ci.example.com."
          errorAction={{ kind: 'open-jenkins-settings' }}
          openUrl={null}
          worktreeId={null}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: /Open Jenkins settings/ }))
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-jenkins'
    })
  })
})
