import React from 'react'
import { Github, Gitlab } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { translate } from '@/i18n/i18n'
import type { WorkspaceLinkedIssueProvider } from './workspace-linked-issue'

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

/** Provider mark for the pane header; brand logos stay monochrome like the rest
 *  of the chrome, inheriting the surrounding text color. */
export function IssueProviderIcon({
  provider,
  className
}: {
  provider: WorkspaceLinkedIssueProvider
  className?: string
}): React.JSX.Element {
  switch (provider) {
    case 'github':
      return <Github className={className} aria-hidden />
    case 'gitlab':
      return <Gitlab className={className} aria-hidden />
    case 'linear':
      return <LinearIcon className={className} />
    case 'jira':
      return <JiraIcon className={className} />
  }
}
