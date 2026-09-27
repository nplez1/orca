// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/github/check-types'
import { ChecksList } from './checks-panel/checks-list'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openCheckRunDetails: vi.fn(), patchOpenCheckRunDetails: vi.fn() })
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

function renderChecksList(details: PRCheckRunDetails): void {
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
            return details
          }}
        />
      </TooltipProvider>
    )
  })
}

beforeEach(() => {
  // Nothing to set up beyond the container the helper creates.
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('a Jenkins check inside the Checks pane', () => {
  it('lists every stage, so the failing and still-running stages are both visible', async () => {
    renderChecksList(jenkinsDetails)
    await act(async () => {
      await Promise.resolve()
    })

    for (const stage of ['Checkout', 'Unit tests', 'Integration tests', 'Deploy']) {
      expect(container.textContent).toContain(stage)
    }
  })

  it('reports the build metadata a status context cannot carry', async () => {
    renderChecksList(jenkinsDetails)
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
    renderChecksList({
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
