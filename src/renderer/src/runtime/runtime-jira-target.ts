import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { ownedSourceTarget, type OwnedSource } from '@/lib/provider-source-target'

/**
 * Owner-routed Jira source. Every Jira read and write resolves the owner here, so a board or issue
 * read lands on the resource's host even when another server is the Active Server.
 */
export type RuntimeJiraSettings = OwnedSource

export function getJiraRuntimeTarget(source: RuntimeJiraSettings): RuntimeClientTarget {
  return ownedSourceTarget(source)
}
