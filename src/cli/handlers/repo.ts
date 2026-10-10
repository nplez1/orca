import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { RuntimeRepoRelocationResult } from '../../shared/repo-relocation-contracts'
import type { CommandHandler } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import { getOptionalPositiveIntegerFlag, getRequiredStringFlag } from '../flags'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime/types'

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
      path: resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set': async ({ flags, client, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const visibility = getRequiredStringFlag(flags, 'external-worktree-visibility')
    if (visibility !== 'show' && visibility !== 'hide' && visibility !== 'inherit') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--external-worktree-visibility must be show, hide, or inherit.'
      )
    }
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.update', {
      repo,
      updates: { externalWorktreeVisibility: visibility === 'inherit' ? null : visibility }
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set-base-ref': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
      repo: getRequiredStringFlag(flags, 'repo'),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo search-refs': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
      repo: getRequiredStringFlag(flags, 'repo'),
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatRepoRefs)
  },
  'repo relocate': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeRepoRelocationResult>('repo.relocate', {
      repo: getRequiredStringFlag(flags, 'repo'),
      dryRun: flags.has('dry-run') ? true : undefined
    })
    printResult(result, json, formatRepoRelocation)
  }
}

/** One line per answer a caller can act on: what it decided, or what it refused to do. */
function formatRepoRelocation(result: RuntimeRepoRelocationResult): string {
  if (result.decision !== 'ready') {
    return `Not applicable: ${REPO_RELOCATION_MESSAGES[result.decision]}`
  }
  const plan = result.plan
  if (!plan) {
    return 'Not applicable.'
  }
  if (!result.outcome) {
    return `Would move ${result.repoId} to ${plan.targetPath}`
  }
  if (result.outcome.kind === 'relocated') {
    return `Moved ${result.outcome.from} to ${result.outcome.to}`
  }
  return `Refused: ${REPO_RELOCATION_MESSAGES[result.outcome.kind]}`
}

const REPO_RELOCATION_MESSAGES: Record<string, string> = {
  'not-project-folder-layout': 'this host is not using the one-folder-per-project layout',
  'already-in-container': 'its checkout is already inside its project folder',
  'remote-host': 'its checkout belongs to another execution host',
  windows: 'Windows is not supported yet',
  'not-a-git-repo': 'folder workspaces have no checkout to move',
  'unknown-default-branch': 'its default branch could not be resolved',
  'live-sessions': 'a terminal is still attached to one of its workspaces',
  'target-exists': 'the destination already exists',
  'cross-volume': 'the destination is on a different volume'
}
