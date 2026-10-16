import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { taskSourceRuntimeTarget } from './task-source-runtime-target'

/**
 * A provider source whose owner is already decided: the row's own task source, or an explicit
 * runtime target. There is deliberately no "use the Active Server" variant — a caller with no row
 * resolves its owner first, through the default-host readers, so a read can never drift to
 * whichever server is focused.
 */
export type OwnedSource = TaskSourceContext | RuntimeClientTarget

/**
 * Transport to an owned source's host; a source that names no server runs on this app. The
 * unresolved-owner sentinel stays a server target so the call fails instead of running locally.
 */
export function ownedSourceTarget(source: OwnedSource): RuntimeClientTarget {
  return source.kind === 'task-source' ? taskSourceRuntimeTarget(source) : source
}
