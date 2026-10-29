import type { AiVaultServicePendingCall } from './session-scanner-service-client-state'

/**
 * Names the transcript in flight when the scanner child faults.
 *
 * Why: the child is a separate process with a 384 MB heap, so the file that exhausts it dies with
 * it and no handler runs. The last reported progress is the only record of what it was reading, and
 * without it a crash loop reads as "the History list is broken" with nothing to point at.
 */
export function describeAiVaultServiceFault(
  error: Error,
  calls: Iterable<AiVaultServicePendingCall>
): Error {
  for (const call of calls) {
    const readingFile = call.readingFile
    if (readingFile) {
      return new Error(`${error.message} (while reading ${readingFile.path})`)
    }
  }
  return error
}
