/**
 * The local name-filter requests a renderer currently has in flight, keyed by the request token it
 * cancels with. A request begins before its first await and is forgotten once it settles, so a
 * cancel fences the whole request lifetime — authorization, service acquisition, index warm — and a
 * settled or unknown token owns nothing, which keeps a late cancel from falling through to the
 * sender id and stopping another consumer's query.
 */
export type FilesystemIndexRequestFence = {
  /** The consumer this request submits its worker query under; null when the renderer named none. */
  readonly consumerId: string | null
  /** This request's own lifetime: aborted by a cancel, a gone renderer, or a reused token. */
  isCancelled: () => boolean
}

export type FilesystemIndexRequestFences = {
  begin: (args: {
    senderId: number
    requestToken: string | undefined
    consumerId: string | null
    signal: AbortSignal | undefined
  }) => FilesystemIndexRequestFence | null
  /** The request this token still has in flight; null once it has settled, or if it never began. */
  liveRequest: (senderId: number, requestToken: string) => FilesystemIndexRequestFence | null
  forget: (
    senderId: number,
    requestToken: string | undefined,
    fence: FilesystemIndexRequestFence | null
  ) => void
}

export function createFilesystemIndexRequestFences(): FilesystemIndexRequestFences {
  const fencesBySender = new Map<number, Map<string, FilesystemIndexRequestFence>>()
  return {
    begin: ({ senderId, requestToken, consumerId, signal }) => {
      if (!requestToken) {
        return null
      }
      let fences = fencesBySender.get(senderId)
      if (!fences) {
        fences = new Map()
        fencesBySender.set(senderId, fences)
      }
      const fence: FilesystemIndexRequestFence = {
        consumerId,
        isCancelled: () => signal?.aborted ?? false
      }
      fences.set(requestToken, fence)
      return fence
    },
    liveRequest: (senderId, requestToken) =>
      fencesBySender.get(senderId)?.get(requestToken) ?? null,
    forget: (senderId, requestToken, fence) => {
      if (!requestToken || !fence) {
        return
      }
      const fences = fencesBySender.get(senderId)
      // Why: a settled request must not delete a newer request that reused its token.
      if (fences?.get(requestToken) !== fence) {
        return
      }
      fences.delete(requestToken)
      if (fences.size === 0) {
        fencesBySender.delete(senderId)
      }
    }
  }
}
