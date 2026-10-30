import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'

type GitHubWorkItemLookupArgs = {
  repoPath: string
  repoId: string
  /** Transport for this read. A caller holding the repo row passes its owner host — a workspace
   *  link can carry no task-source context at all, and the source-context fallback then sends a
   *  runtime-owned repo's read to this app's IPC, which refuses a repo it does not own. */
  target?: RuntimeClientTarget
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type GitHubWorkItemByOwnerRepoLookupArgs = GitHubWorkItemLookupArgs & {
  owner: string
  repo: string
  host?: string
  type: 'issue' | 'pr'
  /** One light call for hover cards; older hosts ignore it. */
  preview?: boolean
}

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  /** Required here: both callers render a workspace's item, where the source context can be null
   *  and the source-context fallback would read a runtime-owned repo on this app's IPC. */
  target: RuntimeClientTarget
  sourceContext?: TaskSourceContext | null
  number: number
  type: 'issue' | 'pr'
  ownerRepo?: GitHubOwnerRepo | null
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

function workItemTarget(
  args: Pick<GitHubWorkItemLookupArgs, 'target' | 'sourceContext'>
): RuntimeClientTarget {
  return args.target ?? getGitHubSourceRuntimeTarget(args.sourceContext)
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = workItemTarget(args)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItem',
          {
            repo: runtimeRepoId(args),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItem({
          repoPath: args.repoPath,
          repoId: args.repoId,
          number: args.number,
          type: args.type
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = workItemTarget(args)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItemByOwnerRepo',
          {
            repo: runtimeRepoId(args),
            owner: args.owner,
            ownerRepo: args.repo,
            ...(args.host ? { host: args.host } : {}),
            number: args.number,
            type: args.type,
            ...(args.preview ? { preview: true } : {})
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItemByOwnerRepo({
          repoPath: args.repoPath,
          repoId: args.repoId,
          sourceContext: args.sourceContext,
          owner: args.owner,
          repo: args.repo,
          ...(args.host ? { host: args.host } : {}),
          number: args.number,
          type: args.type,
          ...(args.preview ? { preview: true } : {})
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

export function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  const sourceContext = args.sourceContext
  const target = args.target
  if (target.kind === 'environment') {
    return callRuntimeRpc<GitHubWorkItemDetails | null>(
      target,
      'github.workItemDetails',
      {
        repo: getGitHubRuntimeRepoId(sourceContext, args.repoId),
        number: args.number,
        type: args.type
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext,
    number: args.number,
    type: args.type,
    ...(args.ownerRepo ? { ownerRepo: args.ownerRepo } : {})
  })
}
