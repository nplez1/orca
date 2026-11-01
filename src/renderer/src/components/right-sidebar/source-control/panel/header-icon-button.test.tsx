// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { ExternalLink } from 'lucide-react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SourceControlHeaderIconButton } from './header-icon-button'

afterEach(cleanup)

describe('SourceControlHeaderIconButton', () => {
  // The attribute is a destructured prop here, which is the shape that can silently drop it.
  it('forwards the declared link address to the button', () => {
    render(
      <TooltipProvider>
        <SourceControlHeaderIconButton
          icon={ExternalLink}
          label="Open review page in browser"
          data-link-url="https://github.com/orca/app/pull/42"
          onClick={() => {}}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button').getAttribute('data-link-url')).toBe(
      'https://github.com/orca/app/pull/42'
    )
  })

  it('omits the attribute when the action opens nothing', () => {
    render(
      <TooltipProvider>
        <SourceControlHeaderIconButton icon={ExternalLink} label="Refresh" onClick={() => {}} />
      </TooltipProvider>
    )

    expect(screen.getByRole('button').hasAttribute('data-link-url')).toBe(false)
  })
})
