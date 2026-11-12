// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import { useAppStore } from '../../../../store/index'
import { RepositoryHostSetupActions } from './RepositoryHostSetupActions'
import type { SetupHostOption } from './repository-host-setup-options'

const DEFAULT_PARENT = '/Users/me/orca/workspaces'

let container: HTMLDivElement
let root: Root

const hostOption: SetupHostOption = {
  id: LOCAL_EXECUTION_HOST_ID,
  label: 'This computer',
  detail: '',
  isAvailable: true,
  canUsePathActions: true
}

const setup: ProjectHostSetup = {
  id: 'setup-1',
  projectId: 'github:stablyai/orca',
  repoId: 'repo-1',
  displayName: 'Orca',
  hostId: 'runtime:gpu',
  path: '',
  kind: 'git',
  setupState: 'not-set-up',
  setupMethod: 'provisioned',
  createdAt: 100,
  updatedAt: 100
}

function settingsWith(workspaceDir: string): GlobalSettings {
  return { ...getDefaultSettings('/Users/me'), workspaceDir }
}

function applySettings(settings: GlobalSettings): void {
  act(() => {
    useAppStore.setState({ settings })
  })
}

function render(): void {
  act(() => {
    root.render(
      React.createElement(RepositoryHostSetupActions, {
        repoDisplayName: 'Orca',
        selectedProjectHostSetup: setup,
        setupHostOptions: [hostOption],
        setupProjectExistingFolder: async () => null,
        setupProjectClone: async () => null,
        createProjectHostSetup: async () => null,
        onSetupReady: () => undefined,
        onAddHostRequestHandled: () => undefined
      })
    )
  })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label
  )
}

// Step action rows carry a title plus a description, so they only ever match on a prefix.
function findActionButton(title: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.trim().startsWith(title)
  )
}

function clickButton(button: HTMLButtonElement | undefined, label: string): void {
  if (!button) {
    throw new Error(`no button labelled ${label}`)
  }
  act(() => {
    button.click()
  })
}

function openCloneStep(): void {
  clickButton(findButton('Add to another host'), 'Add to another host')
  clickButton(findActionButton('Clone from URL'), 'Clone from URL')
}

function getInput(placeholder: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input')).find(
    (candidate) => candidate.placeholder === placeholder
  )
  if (!input) {
    throw new Error(`no input with placeholder ${placeholder}`)
  }
  return input
}

function getDestination(): HTMLInputElement {
  return getInput('/destination/on/host')
}

function changeDestination(text: string): void {
  changeInput('/destination/on/host', text)
}

function changeInput(placeholder: string, text: string): void {
  act(() => {
    const input = getInput(placeholder)
    // Use the native setter so React’s controlled-value tracker recognizes the input.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: settingsWith(DEFAULT_PARENT) })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('RepositoryHostSetupActions clone destination', () => {
  it('seeds the field from the host default', () => {
    render()
    openCloneStep()

    expect(getDestination().value).toBe(DEFAULT_PARENT)
  })

  it('leaves the field empty once cleared, and keeps Clone disabled until a path is entered', () => {
    render()
    openCloneStep()
    changeDestination('')

    expect(getDestination().value).toBe('')
    expect(findButton('Clone')?.disabled).toBe(true)

    changeInput('Repository URL', 'https://github.com/stablyai/orca.git')
    expect(findButton('Clone')?.disabled).toBe(true)

    changeDestination('/srv/src')
    expect(getDestination().value).toBe('/srv/src')
    expect(findButton('Clone')?.disabled).toBe(false)
  })

  it('appends typed text to what the user typed, not to the default', () => {
    render()
    openCloneStep()
    changeDestination('')

    // A keystroke appends to the value the field is showing, which is what the bug rewrote.
    for (const key of ['/', 's', 'r', 'v']) {
      changeDestination(getDestination().value + key)
    }

    expect(getDestination().value).toBe('/srv')
  })

  it('stays empty when the step is revisited after clearing', () => {
    render()
    openCloneStep()
    changeDestination('')
    clickButton(findButton('Clone from URL'), 'Clone from URL')
    clickButton(findActionButton('Clone from URL'), 'Clone from URL')

    expect(getDestination().value).toBe('')
  })

  it('fills an untouched field when the default arrives late', () => {
    applySettings(settingsWith(''))
    render()
    openCloneStep()

    expect(getDestination().value).toBe('')

    applySettings(settingsWith('/srv/clones'))

    expect(getDestination().value).toBe('/srv/clones')
  })

  it('never overwrites typed text with a default that arrives late', () => {
    applySettings(settingsWith(''))
    render()
    openCloneStep()
    changeDestination('/mine')

    applySettings(settingsWith('/srv/clones'))

    expect(getDestination().value).toBe('/mine')
  })
})
