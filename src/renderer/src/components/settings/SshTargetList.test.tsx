// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshTargetList } from './SshTargetList'
import { TooltipProvider } from '../ui/tooltip'
import type { SshTarget } from '../../../../shared/ssh-types'

afterEach(() => {
  document.body.innerHTML = ''
})

const offeredTarget: SshTarget = {
  id: 'ssh-offered',
  label: 'build-01',
  host: 'build-01.internal',
  port: 22,
  username: 'deploy',
  source: 'manual'
}

const hiddenTarget: SshTarget = {
  id: 'ssh-hidden',
  label: 'prod',
  configHost: 'prod',
  host: 'prod.internal',
  port: 22,
  username: 'deploy',
  source: 'ssh-config',
  hidden: true
}

async function renderList(targets: SshTarget[]): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(
      <TooltipProvider>
        <SshTargetList
          targets={targets}
          connectionStates={new Map()}
          testingIds={new Set()}
          busyActionForTarget={() => undefined}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onTerminateSessions={vi.fn()}
          onResetRelay={vi.fn()}
          onTest={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
          onSetHidden={vi.fn()}
        />
      </TooltipProvider>
    )
  })
  return container
}

function cardLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-ssh-target-card]')].map(
    (node) => node.getAttribute('data-ssh-target-label') ?? ''
  )
}

describe('the SSH host list', () => {
  it('says so when nothing is configured', async () => {
    const container = await renderList([])

    expect(container.textContent).toContain('No SSH targets configured')
    expect(container.querySelector('[data-ssh-target-card]')).toBeNull()
  })

  it('shows offered hosts and keeps the hidden ones behind a collapsed count', async () => {
    const container = await renderList([offeredTarget, hiddenTarget])

    expect(cardLabels(container)).toEqual(['build-01'])
    expect(container.textContent).toContain('Hidden (1)')
  })

  it('reveals the hidden hosts when the section is expanded', async () => {
    const container = await renderList([offeredTarget, hiddenTarget])

    const trigger = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Hidden (1)')
    )
    await act(async () => {
      trigger?.click()
    })

    expect(cardLabels(container)).toEqual(['build-01', 'prod'])
    // The hidden row must say why it is here, and offer the way back.
    expect(container.textContent).toContain('Hidden')
    expect(container.querySelector('[aria-label="Unhide host"]')).not.toBeNull()
  })

  it('renders no hidden section when every host is offered', async () => {
    const container = await renderList([offeredTarget])

    expect(container.textContent).not.toContain('Hidden (')
    expect(cardLabels(container)).toEqual(['build-01'])
  })
})
