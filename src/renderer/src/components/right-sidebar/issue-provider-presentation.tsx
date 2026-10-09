import React from 'react'
import { Github, Gitlab } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { translate } from '@/i18n/i18n'
import type { WorkspaceLinkedIssueProvider } from './workspace-linked-issue'

/** Glyph for a slot that takes an icon component rather than an element — the
 *  activity bar's tabs. Not lucide's own `LucideIcon` so the hand-drawn provider
 *  marks qualify for the same slot. */
export type ProviderIconComponent = React.ComponentType<{
  size?: number
  className?: string
  'aria-hidden'?: boolean
}>

export function issueProviderLabel(provider: WorkspaceLinkedIssueProvider): string {
  switch (provider) {
    case 'github':
      return translate('auto.components.right.sidebar.IssuePane.providerGithub', 'GitHub')
    case 'linear':
      return translate('auto.components.right.sidebar.IssuePane.providerLinear', 'Linear')
    case 'jira':
      return translate('auto.components.right.sidebar.IssuePane.providerJira', 'Jira')
    case 'gitlab':
      return translate('auto.components.right.sidebar.IssuePane.providerGitlab', 'GitLab')
  }
}

/** The provider's mark. One table for both the pane header, which renders it, and
 *  the activity bar, which needs the component itself. Brand logos stay
 *  monochrome like the rest of the chrome, inheriting the surrounding text color. */
const PROVIDER_ICONS: Record<WorkspaceLinkedIssueProvider, ProviderIconComponent> = {
  github: Github,
  gitlab: Gitlab,
  linear: LinearIcon,
  jira: JiraIcon
}

export function providerIconComponent(
  provider: WorkspaceLinkedIssueProvider
): ProviderIconComponent {
  return PROVIDER_ICONS[provider]
}

export function IssueProviderIcon({
  provider,
  className
}: {
  provider: WorkspaceLinkedIssueProvider
  className?: string
}): React.JSX.Element {
  const Mark = PROVIDER_ICONS[provider]
  return <Mark className={className} aria-hidden />
}
