// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ProjectViewErrorState } from './ProjectViewStates'

afterEach(cleanup)

describe('ProjectViewErrorState', () => {
  // The wrapper computes this address, so the error state must pass it through to its button.
  it('declares the address its Open in GitHub button opens', () => {
    render(
      <TooltipProvider>
        <ProjectViewErrorState
          error={{ type: 'not_found', message: 'Not found' }}
          openInGitHubUrl="https://github.com/orca/app/projects/1/views/2"
          onOpenInGitHub={() => {}}
        />
      </TooltipProvider>
    )

    expect(
      screen.getByRole('button', { name: /Open in GitHub/ }).getAttribute('data-link-url')
    ).toBe('https://github.com/orca/app/projects/1/views/2')
  })
})
