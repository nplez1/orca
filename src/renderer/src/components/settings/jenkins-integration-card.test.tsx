// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JenkinsServerSummary } from '../../../../shared/jenkins-servers'

const mocks = vi.hoisted(() => ({
  listServers: vi.fn(),
  testServer: vi.fn(),
  removeServer: vi.fn(),
  saveServer: vi.fn()
}))

vi.mock('./jenkins-server-dialog', () => ({
  JenkinsServerDialog: ({ open, server }: { open: boolean; server: { id: string } | null }) =>
    open ? <div>Server dialog open {server?.id ?? 'new'}</div> : null
}))

import { JenkinsIntegrationCard } from './jenkins-integration-card'

const server = (overrides: Partial<JenkinsServerSummary> = {}): JenkinsServerSummary => ({
  id: 'server-1',
  label: 'Product CI',
  baseUrl: 'https://ci.example.com/jenkins',
  username: 'ada',
  hasToken: true,
  ...overrides
})

let container: HTMLDivElement
let root: Root

async function renderCard(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<JenkinsIntegrationCard />)
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  )
  if (!button) {
    throw new Error(`Button "${text}" not rendered`)
  }
  return button
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) {
    throw new Error(`Button labelled "${label}" not rendered`)
  }
  return button
}

beforeEach(() => {
  mocks.listServers.mockReset().mockResolvedValue([server()])
  mocks.testServer.mockReset().mockResolvedValue({ ok: true, version: '2.452.1' })
  mocks.removeServer.mockReset().mockResolvedValue({ ok: true })
  mocks.saveServer.mockReset()
  vi.stubGlobal('api', {
    jenkins: {
      listServers: mocks.listServers,
      testServer: mocks.testServer,
      removeServer: mocks.removeServer,
      saveServer: mocks.saveServer
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('Jenkins integration card', () => {
  it('lists every configured server so a user with several can check them', async () => {
    mocks.listServers.mockResolvedValue([
      server(),
      server({ id: 'server-2', label: 'Platform CI', baseUrl: 'https://platform.example.com' })
    ])
    await renderCard()

    expect(container.textContent).toContain('Product CI')
    expect(container.textContent).toContain('https://ci.example.com/jenkins')
    expect(container.textContent).toContain('Platform CI')
    expect(container.textContent).toContain('2 configured')
  })

  it('says nothing is configured when the list is empty', async () => {
    mocks.listServers.mockResolvedValue([])
    await renderCard()

    expect(container.textContent).toContain('Not configured')
  })

  it('reports the Jenkins version a test connection found', async () => {
    await renderCard()

    await act(async () => {
      buttonByText('Test').click()
    })

    expect(mocks.testServer).toHaveBeenCalledWith({ id: 'server-1' })
    expect(container.textContent).toContain('Connected to Jenkins 2.452.1')
  })

  it('shows the reason a test connection failed', async () => {
    mocks.testServer.mockResolvedValue({ ok: false, error: 'Jenkins rejected those credentials.' })
    await renderCard()

    await act(async () => {
      buttonByText('Test').click()
    })

    expect(container.textContent).toContain('Jenkins rejected those credentials.')
  })

  it('removes a server and reloads the list', async () => {
    await renderCard()

    await act(async () => {
      buttonByLabel('Remove Product CI').click()
    })

    expect(mocks.removeServer).toHaveBeenCalledWith({ id: 'server-1' })
    expect(mocks.listServers).toHaveBeenCalledTimes(2)
  })

  it('opens the add dialog with no server selected', async () => {
    mocks.listServers.mockResolvedValue([])
    await renderCard()

    await act(async () => {
      buttonByText('Add server').click()
    })

    expect(container.textContent).toContain('Server dialog open new')
  })

  it('opens the edit dialog for the server whose row was clicked', async () => {
    await renderCard()

    await act(async () => {
      buttonByLabel('Edit Product CI').click()
    })

    expect(container.textContent).toContain('Server dialog open server-1')
  })

  it('marks a server with no stored token instead of implying it can authenticate', async () => {
    mocks.listServers.mockResolvedValue([server({ hasToken: false })])
    await renderCard()

    expect(container.textContent).toContain('no token saved')
  })
})
