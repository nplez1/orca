import type { AiVaultServicePendingCall } from './session-scanner-service-client-state'

/**
 * Names the transcripts in flight when the scanner child faults.
 *
 * Why: the child is a separate process with a 384 MB heap, so the file that exhausts it dies with
 * it and no handler runs. The last reported progress is the only record of what it was reading, and
 * without it a crash loop reads as "the History list is broken" with nothing to point at.
 *
 * Why every path and not one: parses run several at a time, so a single remembered path names the
 * wrong file about that often. The batch is bounded, so listing it stays short.
 */
export function describeAiVaultServiceFault(
  error: Error,
  calls: Iterable<AiVaultServicePendingCall>
): Error {
  const paths = new Set<string>()
  for (const call of calls) {
    for (const file of call.readingFiles ?? []) {
      paths.add(file.path)
    }
  }
  if (paths.size === 0) {
    return error
  }
  return new Error(`${error.message} (while reading ${[...paths].join(', ')})`)
}
