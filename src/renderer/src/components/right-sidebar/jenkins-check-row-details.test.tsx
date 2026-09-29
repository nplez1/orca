// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { JenkinsCheckDetailsError } from '@/lib/check-details-error-action'
import { ChecksList } from './checks-panel/checks-list'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const openSettingsTarget = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openCheckRunDetails: vi.fn(),
      patchOpenCheckRunDetails: vi.fn(),
      openSettingsTarget
    })
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: () => null
}))

/**
 * The Jenkins case this pane exists for: the check's own state says only "failed", and the pane has
 * to name the stage that broke — including the one still running in a live build.
 */
const jenkinsCheck: PRCheckDetail = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/12/display/redirect'
}

const jenkinsDetails: PRCheckRunDetails = {
  name: jenkinsCheck.name,
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/12/',
  detailsUrl: 'https://ci.example.com/job/team/job/repo/12/',
  startedAt: '2026-06-16T12:00:00Z',
  completedAt: '2026-06-16T12:04:12Z',
  title: 'team » repo » main #12',
  summary: null,
  text: null,
  annotations: [],
  jobs: [
    {
      id: 12,
      name: '#12',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-06-16T12:00:00Z',
      completedAt: '2026-06-16T12:04:12Z',
      url: 'https://ci.example.com/job/team/job/repo/12/',
      logTail: null,
      stepRendering: 'all',
      steps: [
        {
          name: 'Checkout',
          status: 'completed',
          conclusion: 'success',
          startedAt: null,
          completedAt: null
        },
        {
          name: 'Unit tests',
          status: 'completed',
          conclusion: 'failure',
          startedAt: null,
          completedAt: null
        },
        {
          name: 'Integration tests',
          status: 'in_progress',
          conclusion: 'pending',
          startedAt: null,
          completedAt: null
        },
        {
          name: 'Deploy',
          status: 'completed',
          conclusion: 'skipped',
          startedAt: null,
          completedAt: null
        }
      ]
    }
  ],
  build: {
    number: '12',
    queuedMs: 1500,
    estimatedDurationMs: 240_000,
    triggeredBy: 'Started by user Ada',
    parameters: [{ name: 'GITHUB_TOKEN', value: '••••', secret: true }],
    commits: [{ id: 'abc123def456', message: 'Fix the thing', author: 'Ada Lovelace' }]
  }
}

let container: HTMLDivElement
let root: Root

function renderChecksList(
  load: () => PRCheckRunDetails | null | Promise<PRCheckRunDetails | null>
): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <ChecksList
          checks={[jenkinsCheck]}
          checksLoading={false}
          checkDetailsContextKey="repo:42"
          worktreeId="wt-1"
          detailsStickySurface="sidebar"
          onLoadCheckDetails={async () => {
            await Promise.resolve()
            return load()
          }}
        />
      </TooltipProvider>
    )
  })
}

function renderJenkinsDetails(details: PRCheckRunDetails): void {
  renderChecksList(() => details)
}

beforeEach(() => {
  openSettingsTarget.mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('a Jenkins check inside the Checks pane', () => {
  it('reduces the stage list to the failing and still-running stages', async () => {
    renderJenkinsDetails(jenkinsDetails)
    await act(async () => {
      await Promise.resolve()
    })

    for (const stage of ['Unit tests', 'Integration tests']) {
      expect(container.textContent).toContain(stage)
    }
    // A passing or skipped stage is noise in a pipeline with hundreds of stages.
    expect(container.textContent).not.toContain('Checkout')
    expect(container.textContent).not.toContain('Deploy')
  })

  it('caps the stage list and says how many it held back', async () => {
    const manyFailures = Array.from({ length: 12 }, (_, index) => ({
      name: `Stage ${index}`,
      status: 'completed',
      conclusion: 'failure',
      startedAt: null,
      completedAt: null
    }))
    renderJenkinsDetails({
      ...jenkinsDetails,
      jobs: [{ ...jenkinsDetails.jobs[0], steps: manyFailures }]
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Stage 7')
    expect(container.textContent).not.toContain('Stage 8')
    expect(container.textContent).toContain('+4 more stages')
  })

  it('offers a Jenkins settings link when the account cannot read the job', async () => {
    renderChecksList(() =>
      Promise.reject(
        new JenkinsCheckDetailsError(
          'forbidden',
          'https://ci.example.com',
          'The saved Jenkins account cannot read this job on https://ci.example.com.'
        )
      )
    )
    await act(async () => {
      await Promise.resolve()
    })

    const settingsButton = screen.getByRole('button', { name: /Open Jenkins settings/ })
    fireEvent.click(settingsButton)
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-jenkins'
    })
  })

  it('clears the settings link once a retry succeeds', async () => {
    let attempt = 0
    renderChecksList(async () => {
      attempt += 1
      if (attempt === 1) {
        throw new JenkinsCheckDetailsError(
          'forbidden',
          'https://ci.example.com',
          'The saved Jenkins account cannot read this job on https://ci.example.com.'
        )
      }
      return jenkinsDetails
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /Open Jenkins settings/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: /Open Jenkins settings/ })).toBeNull()
    expect(container.textContent).toContain('Unit tests')
  })

  it('reports the build metadata a status context cannot carry', async () => {
    renderJenkinsDetails(jenkinsDetails)
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('#12')
    expect(container.textContent).toContain('Started by user Ada')
    expect(container.textContent).toContain('Queued2s')
    expect(container.textContent).toContain('4m')
    expect(container.textContent).toContain('GITHUB_TOKEN')
    // A secret parameter value must never be rendered.
    expect(container.textContent).not.toContain('hunter2')
    expect(container.textContent).toContain('Fix the thing')
  })

  it('still shows a GitHub Actions job as failures only', async () => {
    renderJenkinsDetails({
      ...jenkinsDetails,
      title: 'Verify failed',
      jobs: [
        {
          ...jenkinsDetails.jobs[0],
          stepRendering: undefined,
          steps: [
            {
              name: 'Checkout',
              status: 'completed',
              conclusion: 'success',
              startedAt: null,
              completedAt: null
            },
            {
              name: 'Unit tests',
              status: 'completed',
              conclusion: 'failure',
              startedAt: null,
              completedAt: null
            }
          ]
        }
      ],
      build: undefined
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Unit tests')
    expect(container.textContent).not.toContain('Checkout')
    expect(container.textContent).not.toContain('Started by user Ada')
  })
})
