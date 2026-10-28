// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { JenkinsRebuildButton } from './jenkins-rebuild-button'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const rerunJenkinsCheck = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, message: 'Jenkins is rerunning build #12' }))
)
const hasJenkinsApi = vi.hoisted(() => vi.fn(() => true))

vi.mock('@/runtime/jenkins-rebuild-client', () => ({
  hasJenkinsApi,
  rerunJenkinsCheck
}))

const jenkinsCheck: PRCheckDetail = {
  name: 'continuous-integration/jenkins/pr-merge',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://ci.example.com/job/team/job/repo/12/display/redirect'
}

let container: HTMLDivElement
let root: Root

function render(check: PRCheckDetail, props: { iconOnly?: boolean } = {}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <JenkinsRebuildButton check={check} {...props} />
      </TooltipProvider>
    )
  })
}

beforeEach(() => {
  rerunJenkinsCheck.mockClear()
  hasJenkinsApi.mockReturnValue(true)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('JenkinsRebuildButton', () => {
  it('is a labelled button in a details pane and an icon in a check row', () => {
    render(jenkinsCheck)
    expect(container.textContent).toContain('Rerun build')
    act(() => {
      root.unmount()
    })
    container.remove()

    render(jenkinsCheck, { iconOnly: true })
    // Why the label is an aria-label here: the row's own name has the width, so the icon is the
    // affordance and the tooltip carries the words.
    expect(screen.getByRole('button', { name: 'Rerun build' })).toBeTruthy()
    expect(container.textContent).not.toContain('Rerun build')
  })

  it('reruns the build the row belongs to', () => {
    render(jenkinsCheck, { iconOnly: true })

    fireEvent.click(screen.getByRole('button', { name: 'Rerun build' }))

    expect(rerunJenkinsCheck).toHaveBeenCalledWith(jenkinsCheck)
  })

  it('renders nothing for a check another provider owns', () => {
    render({
      ...jenkinsCheck,
      url: 'https://github.com/stablyai/orca/actions/runs/123/job/456'
    })

    expect(container.textContent).toBe('')
  })

  it('renders nothing for a build that is still running', () => {
    // Why: a second build of a job that is already building is not a rerun, and Jenkins would run
    // them concurrently in one workspace.
    render({ ...jenkinsCheck, status: 'in_progress', conclusion: null })

    expect(container.textContent).toBe('')
  })

  it('renders nothing for a Jenkins check that publishes a check run', () => {
    // Why: that check is rerun by rerequesting its check run, which needs no Jenkins credentials
    // here — offering this button would contradict the toolbar about the same build.
    render({ ...jenkinsCheck, checkRunId: 42 })

    expect(container.textContent).toBe('')
  })

  it('renders nothing in a client with no Jenkins surface', () => {
    hasJenkinsApi.mockReturnValue(false)

    render(jenkinsCheck)

    expect(container.textContent).toBe('')
  })
})
