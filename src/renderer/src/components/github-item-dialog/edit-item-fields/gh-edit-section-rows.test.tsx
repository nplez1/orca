// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { GHEditSectionRows } from './gh-edit-section-rows'
import type { GHEditSectionPillsProps } from './gh-edit-section-pills'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

const item: GitHubWorkItem = {
  id: 'issue-7',
  type: 'issue',
  number: 7,
  title: 'Crash on launch',
  state: 'open',
  url: 'https://github.com/acme/orca/issues/7',
  labels: [],
  updatedAt: '2026-09-01T00:00:00.000Z',
  author: null,
  repoId: 'repo-1'
}

function props(overrides: Partial<GHEditSectionPillsProps> = {}): GHEditSectionPillsProps {
  return {
    item,
    localState: 'open',
    localLabels: ['bug'],
    localAssignees: [],
    repoLabels: { data: ['bug', 'ui'], loading: false, error: null },
    repoAssignees: { data: [], loading: false, error: null },
    repositoryLabelsUrl: null,
    isStatePending: false,
    isAssigneesPending: false,
    isLabelsPending: false,
    statusPopoverOpen: false,
    assigneePopoverOpen: false,
    labelPopoverOpen: false,
    duplicatePickerOpen: false,
    duplicateSearch: '',
    duplicateError: null,
    duplicatePickerTitle: 'Repository',
    filteredDuplicateCandidates: [],
    directDuplicateTarget: null,
    onStatusOpenChange: () => {},
    onAssigneeOpenChange: () => {},
    onLabelOpenChange: () => {},
    onStateChange: () => {},
    onDuplicateSearchChange: () => {},
    onDuplicateSearchSubmit: () => {},
    onCloseAsDuplicate: () => {},
    onBackFromDuplicate: () => {},
    onOpenDuplicatePicker: () => {},
    onAssigneeToggle: () => {},
    onLabelToggle: () => {},
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    value: { gh: { viewer: () => Promise.resolve(null) } },
    configurable: true,
    writable: true
  })
})

describe('GHEditSectionRows', () => {
  it('renders the compact status, assignees and labels rows', () => {
    render(<GHEditSectionRows {...props()} />)
    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('Open')).toBeTruthy()
    expect(screen.getByText('Assignees')).toBeTruthy()
    expect(screen.getByText('Labels')).toBeTruthy()
    expect(screen.getByText('bug')).toBeTruthy()
  })
})
