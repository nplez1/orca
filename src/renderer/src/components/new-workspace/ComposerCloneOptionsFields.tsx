import React from 'react'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslate } from '@/i18n/use-translate'
import {
  detectGitRemoteTransport,
  rewriteGitRemoteTransport,
  type GitRemoteTransport
} from '../../../../shared/git/remotes/git-remote-url-transport'
import type { RunTargetAutoClone } from './use-run-target-auto-clone'

const TRANSPORTS: readonly GitRemoteTransport[] = ['ssh', 'https']

/**
 * The overrides a clone onto another host can take, all optional.
 *
 * Empty is the normal case: the URL defaults to the selected project's own remote and the
 * destination to that host's checkout folder. They exist for the two ways a default can be wrong — a
 * host with no SSH key, or a folder that is already taken — so they apply to the next start, never to
 * a clone already running.
 */
export function ComposerCloneOptionsFields({
  clone
}: {
  clone: RunTargetAutoClone
}): React.JSX.Element {
  const t = useTranslate()
  const running = clone.status.kind === 'resolving' || clone.status.kind === 'cloning'
  const url = clone.overrides.url || clone.defaultUrl
  const transport = detectGitRemoteTransport(url)
  const switchTransport = (to: GitRemoteTransport): void => {
    if (to === transport) {
      return
    }
    const rewritten = rewriteGitRemoteTransport(url, to)
    if (rewritten) {
      clone.setOverrides({ url: rewritten })
    }
  }
  return (
    <div className="space-y-2" data-clone-options="true">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t('auto.components.NewWorkspaceComposerCard.cloneRepoUrl', 'Repository URL')}
        </label>
        <Input
          value={clone.overrides.url}
          onChange={(event) => clone.setOverrides({ url: event.target.value })}
          placeholder={clone.defaultUrl}
          disabled={running}
          spellCheck={false}
          variant="code"
          aria-label={t('auto.components.NewWorkspaceComposerCard.cloneRepoUrl', 'Repository URL')}
        />
      </div>
      {transport ? (
        <ToggleGroup
          type="single"
          value={transport}
          onValueChange={(value) => {
            if (value === 'ssh' || value === 'https') {
              switchTransport(value)
            }
          }}
          variant="outline"
          size="xs"
          disabled={running}
          aria-label={t('auto.components.NewWorkspaceComposerCard.cloneProtocol', 'Clone protocol')}
        >
          {TRANSPORTS.map((candidate) => (
            <ToggleGroupItem
              key={candidate}
              value={candidate}
              // Capture pointer intent before Radix roving focus can consume the click.
              onPointerDownCapture={() => switchTransport(candidate)}
            >
              {candidate === 'ssh' ? 'SSH' : 'HTTPS'}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">
          {t('auto.components.NewWorkspaceComposerCard.cloneDestination', 'Destination folder')}
        </label>
        <Input
          value={clone.overrides.destination}
          onChange={(event) => clone.setOverrides({ destination: event.target.value })}
          placeholder={t(
            'auto.components.NewWorkspaceComposerCard.cloneDestinationDefault',
            "This host's checkout folder"
          )}
          disabled={running}
          spellCheck={false}
          variant="code"
          aria-label={t(
            'auto.components.NewWorkspaceComposerCard.cloneDestination',
            'Destination folder'
          )}
        />
      </div>
    </div>
  )
}
