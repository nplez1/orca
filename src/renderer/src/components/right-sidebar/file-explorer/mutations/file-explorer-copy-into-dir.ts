import { basename, dirname, joinPath } from '@/lib/path'
import { copyRuntimePath } from '@/runtime/files/mutations/runtime-file-mutation-client'
import { runtimePathExists } from '@/runtime/files/metadata/runtime-file-metadata-client'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { FileExplorerOperationGuard } from '../navigation/file-explorer-operation-owner'
import { copyNameCandidates } from './file-explorer-move-copy-paths'

const MAX_EEXIST_RETRIES = 10

export function fileExplorerGuardContext(
  operationGuard: FileExplorerOperationGuard,
  worktreeId: string | null,
  worktreePath: string
): RuntimeFileOperationArgs {
  const { route } = operationGuard
  return {
    target: route.target,
    worktreeId,
    worktreePath,
    connectionId: route.connectionId,
    expectedExecutionHostId: route.expectedExecutionHostId,
    expectedSshTargetId: route.expectedSshTargetId,
    expectedSshConnectionGeneration: route.expectedSshConnectionGeneration
  }
}

/** Copies a file into `destDir` under the first free name; the host copy is exclusive, so a name taken meanwhile retries the next one. */
export async function copyFileIntoDir({
  context,
  operationGuard,
  sourcePath,
  destDir
}: {
  context: RuntimeFileOperationArgs
  operationGuard: FileExplorerOperationGuard
  sourcePath: string
  destDir: string
}): Promise<string> {
  const names = copyNameCandidates(basename(sourcePath), dirname(sourcePath) !== destDir)
  const nextCandidate = (): string => joinPath(destDir, names.next().value)
  let candidate = nextCandidate()
  while (await runtimePathExists(context, candidate)) {
    candidate = nextCandidate()
  }
  for (let retries = 0; ; retries += 1) {
    try {
      operationGuard.assertCurrent()
      await copyRuntimePath(context, sourcePath, candidate)
      return candidate
    } catch (err) {
      const isEexist =
        err instanceof Error &&
        (err.message.includes('EEXIST') || err.message.includes('already exists'))
      if (!isEexist || retries >= MAX_EEXIST_RETRIES) {
        throw err
      }
      candidate = nextCandidate()
    }
  }
}
