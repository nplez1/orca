import { defineFixture } from '../../component-fixtures/component-fixture'
import { IssuePaneHeader } from './IssuePaneHeader'

const issues = [
  { key: 'github:#12', provider: 'github' as const, identifier: '#12', title: 'Crash on launch' },
  { key: 'github:#13', provider: 'github' as const, identifier: '#13', title: 'Checkout is slow' },
  {
    key: 'jira:PROJ-7',
    provider: 'jira' as const,
    identifier: 'PROJ-7',
    title: 'Session restores into the wrong directory after a folder rename'
  }
]

const terminalActions = {
  onRefresh: () => {},
  onOpenIssue: () => {},
  onUnlinkIssue: () => {},
  onLinkAnotherIssue: () => {}
}

export const severalIssues = defineFixture({
  width: 320,
  render: () => (
    <IssuePaneHeader
      provider="github"
      identifier="#12"
      title="Crash on launch"
      openUrl="https://github.invalid/acme/orca/issues/12"
      {...terminalActions}
      issueSwitcher={{ options: issues, selectedKey: 'github:#12', onSelectIssue: () => {} }}
    />
  )
})

export const severalIssuesOpen = defineFixture({
  width: 320,
  render: () => (
    <IssuePaneHeader
      provider="github"
      identifier="#12"
      title="Crash on launch"
      openUrl="https://github.invalid/acme/orca/issues/12"
      {...terminalActions}
      issueSwitcher={{ options: issues, selectedKey: 'github:#12', onSelectIssue: () => {} }}
    />
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('[data-testid="issue-pane-switcher"]')
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    )
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }
})

export const oneIssue = defineFixture({
  width: 320,
  render: () => (
    <IssuePaneHeader
      provider="github"
      identifier="#12"
      title="Crash on launch"
      openUrl="https://github.invalid/acme/orca/issues/12"
      {...terminalActions}
      issueSwitcher={{
        options: issues.slice(0, 1),
        selectedKey: 'github:#12',
        onSelectIssue: () => {}
      }}
    />
  )
})
