/**
 * Which path-index consumer each request token submitted under. A renderer that names its own
 * consumer owns a worker query the sender-id fallback cannot reach, so cancellation has to be
 * routed by token; the sender id stays the identity for renderers that name none.
 */
export type FilesystemIndexConsumerTokens = {
  record: (senderId: number, requestToken: string | undefined, consumerId: string) => void
  lookup: (senderId: number, requestToken: string) => string | null
  forget: (senderId: number, requestToken: string | undefined) => void
}

export function createFilesystemIndexConsumerTokens(): FilesystemIndexConsumerTokens {
  const tokensBySender = new Map<number, Map<string, string>>()
  const forget = (senderId: number, requestToken: string | undefined): void => {
    if (!requestToken) {
      return
    }
    const tokens = tokensBySender.get(senderId)
    if (!tokens?.delete(requestToken)) {
      return
    }
    if (tokens.size === 0) {
      tokensBySender.delete(senderId)
    }
  }
  return {
    record: (senderId, requestToken, consumerId) => {
      if (!requestToken) {
        return
      }
      let tokens = tokensBySender.get(senderId)
      if (!tokens) {
        tokens = new Map()
        tokensBySender.set(senderId, tokens)
      }
      tokens.set(requestToken, consumerId)
    },
    // Why: a repeated cancel re-reaches the same consumer instead of falling through to the sender id.
    lookup: (senderId, requestToken) => tokensBySender.get(senderId)?.get(requestToken) ?? null,
    forget
  }
}
