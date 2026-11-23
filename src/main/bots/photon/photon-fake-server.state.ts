// The fake server's state, in its own file: the router is about behaviour, these are about shape.

export type FakeProject = { id: string; slug: string; name: string; organizationId: string }
export type FakeAssignment = { id: string; handle: string; assignedPhoneNumber: string }
export type FakeMessage = {
  conversationId: string
  text: string
  idempotencyKey: string | undefined
  /** Present when the send carried a key, which is the case that can be replayed. */
  id?: string
}

export type FakePhotonState = {
  projects: Map<string, FakeProject>
  /** Idempotency key → the resource id it first produced, per endpoint family. */
  idempotency: Map<string, string>
  keys: Map<string, { projectId: string; secret: string; revoked: boolean }>
  assignments: Map<string, FakeAssignment & { projectId: string }>
  sent: FakeMessage[]
  /** Requests seen, as "METHOD /path", for assertions about what the client actually did. */
  requests: string[]
  /** How many closure reads stay `closing` before the project is reported closed. */
  closureReadsRemaining: number
  /** Set to make the next send fail with this status; cleared when it fires. */
  failNextSend?: number
  /** Set to make the next assignment create fail with this status. */
  failNextAssignment?: number
  /** Set to make the next key mint fail with this status. */
  failNextKeyMint?: number
  deleted: string[]
}
