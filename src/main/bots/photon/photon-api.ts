// Photon's Beta HTTPS client: provisioning, keys, assignments, sends and cleanup, each pinned to a
// contract date and each response parsed rather than trusted. Two credentials with two blast radii —
// the account service key creates projects and mints keys, a project key holds one project's number
// and messages — so every call names which it takes instead of a client that could use either.
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import {
  PHOTON_API_BASE,
  PHOTON_VERSION,
  PHOTON_VERSION_HEADER,
  PhotonAssignmentListSchema,
  PhotonAssignmentSchema,
  PhotonClosureSchema,
  PhotonProjectKeySchema,
  PhotonProjectListSchema,
  PhotonProjectSchema,
  photonParse,
  type PhotonAssignment,
  type PhotonClosure,
  type PhotonProject,
  type PhotonProjectKey
} from './photon-contract'

/** The credential a call takes; a project key is never accepted where the account key is required. */
export type PhotonCredential = { kind: 'account'; key: string } | { kind: 'project'; key: string }

export type PhotonFetch = (input: string, init: RequestInit) => Promise<Response>

export type PhotonApiOptions = {
  /** Beta's root; tests point this at a fake server, production leaves it at the pinned default. */
  baseUrl?: string
  fetchImpl?: PhotonFetch
  /** Injected so an idempotency key is deterministic in a test and random in a run. */
  newIdempotencyKey?: () => string
  log?: (message: string, ...rest: unknown[]) => void
}

export class PhotonApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    /** What the server said, already cut to something a log can carry. Never a success body: a 2xx
     *  that was not JSON is reported as such, because that body can be a mint's new key. */
    readonly body: string
  ) {
    super(`Photon ${method} ${path} failed: ${status} ${body}`)
    this.name = 'PhotonApiError'
  }

  /** 404 on a read means the resource is gone, which the reconciler reads as "create it". */
  get isMissing(): boolean {
    return this.status === 404
  }
}

type CallRequest = {
  method: string
  path: string
  idempotencyKey?: string
  body?: unknown
  /** A read reads a missing resource as absence rather than as an error. */
  missingIsNull?: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** An error payload as one bounded line: enough to name the problem, short enough not to carry a body. */
function describe(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200)
}

export class PhotonApi {
  private readonly baseUrl: string
  private readonly fetchImpl: PhotonFetch
  private readonly newIdempotencyKey: () => string

  constructor(options: PhotonApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PHOTON_API_BASE).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.newIdempotencyKey = options.newIdempotencyKey ?? (() => randomUUID())
  }

  /** The `Idempotency-Key` a retried step reuses, so a replay returns the first result. */
  idempotencyKey(): string {
    return this.newIdempotencyKey()
  }

  /** Creates a project under the organization the account key is scoped to. The slug is the natural
   *  key: it is immutable, so a retry finds the existing project rather than making a second one. */
  async createProject(input: {
    credential: PhotonCredential
    organizationId: string
    slug: string
    name: string
    idempotencyKey: string
  }): Promise<PhotonProject> {
    return this.created(input.credential, PhotonProjectSchema, 'project', {
      method: 'POST',
      path: `/organizations/${encodeURIComponent(input.organizationId)}/projects`,
      idempotencyKey: input.idempotencyKey,
      body: { slug: input.slug, name: input.name }
    })
  }

  /** Lists the organization's projects, which is how a slug that is already taken is adopted rather
   *  than retried forever: the slug is the natural key and two bots with one name derive the same one. */
  async findProjectBySlug(
    credential: PhotonCredential,
    organizationId: string,
    slug: string
  ): Promise<PhotonProject | null> {
    const listed = await this.read(credential, PhotonProjectListSchema, 'project list', {
      method: 'GET',
      path: `/organizations/${encodeURIComponent(organizationId)}/projects`,
      missingIsNull: true
    })
    return listed?.projects.find((project) => project.slug === slug) ?? null
  }

  /** Reads a project back, which is how the reconciler learns what a half-finished saga really did. */
  async getProject(credential: PhotonCredential, projectId: string): Promise<PhotonProject | null> {
    return this.read(credential, PhotonProjectSchema, 'project', {
      method: 'GET',
      path: `/projects/${encodeURIComponent(projectId)}`,
      missingIsNull: true
    })
  }

  /** Mints a project key. The secret is returned only here and on an idempotent replay, never again. */
  async mintProjectKey(input: {
    credential: PhotonCredential
    projectId: string
    name: string
    idempotencyKey: string
  }): Promise<PhotonProjectKey> {
    return this.created(input.credential, PhotonProjectKeySchema, 'project key', {
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/keys`,
      idempotencyKey: input.idempotencyKey,
      body: { name: input.name }
    })
  }

  async revokeProjectKey(
    credential: PhotonCredential,
    projectId: string,
    keyId: string
  ): Promise<void> {
    await this.write(credential, {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(keyId)}`
    })
  }

  /** Gives the bot a number for one person. This call is also the allowlist entry: only an assigned
   *  handle reaches the shared-line stream. */
  async createAssignment(input: {
    credential: PhotonCredential
    projectId: string
    handle: string
    idempotencyKey: string
  }): Promise<PhotonAssignment> {
    return this.created(input.credential, PhotonAssignmentSchema, 'iMessage assignment', {
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/platforms/imessage/assignments`,
      idempotencyKey: input.idempotencyKey,
      body: { handle: input.handle }
    })
  }

  async listAssignments(
    credential: PhotonCredential,
    projectId: string
  ): Promise<PhotonAssignment[]> {
    const listed = await this.read(
      credential,
      PhotonAssignmentListSchema,
      'iMessage assignment list',
      {
        method: 'GET',
        path: `/projects/${encodeURIComponent(projectId)}/platforms/imessage/assignments`,
        missingIsNull: true
      }
    )
    return listed?.assignments ?? []
  }

  /** Releases a number. Reversible: adding the handle again gives it back. */
  async releaseAssignment(
    credential: PhotonCredential,
    projectId: string,
    assignmentId: string
  ): Promise<void> {
    await this.write(credential, {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(projectId)}/platforms/imessage/assignments/${encodeURIComponent(assignmentId)}`
    })
  }

  /** Sends one message to a conversation Orca already has. Never a cold start: the conversation id
   *  comes from the inbox, which only an inbound message creates. */
  async sendMessage(input: {
    credential: PhotonCredential
    projectId: string
    conversationId: string
    text: string
    idempotencyKey: string
  }): Promise<void> {
    await this.write(input.credential, {
      method: 'POST',
      path: `/projects/${encodeURIComponent(input.projectId)}/platforms/imessage/messages`,
      idempotencyKey: input.idempotencyKey,
      body: { conversationId: input.conversationId, text: input.text }
    })
  }

  /** Project deletion: the one irreversible step. The slug is burned forever, so this is only ever an
   *  explicit, separately confirmed cleanup — never a bot delete. */
  async deleteProject(
    credential: PhotonCredential,
    projectId: string,
    idempotencyKey: string
  ): Promise<void> {
    await this.write(credential, {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(projectId)}`,
      idempotencyKey
    })
  }

  /** Deletion runs asynchronously; a `closing` answer is reported as still closing, never as success. */
  async getProjectClosure(credential: PhotonCredential, projectId: string): Promise<PhotonClosure> {
    const closure = await this.read(credential, PhotonClosureSchema, 'project closure', {
      method: 'GET',
      path: `/projects/${encodeURIComponent(projectId)}/closure`
    })
    if (!closure) {
      throw new PhotonApiError(404, 'GET', `/projects/${projectId}/closure`, 'no closure')
    }
    return closure
  }

  private async call(credential: PhotonCredential, request: CallRequest): Promise<unknown> {
    const headers: Record<string, string> = {
      ...JSON_HEADERS,
      authorization: `Bearer ${credential.key}`,
      [PHOTON_VERSION_HEADER]: PHOTON_VERSION
    }
    if (request.idempotencyKey) {
      headers['idempotency-key'] = request.idempotencyKey
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      })
    } catch (error) {
      throw new PhotonApiError(0, request.method, request.path, String(error))
    }
    const body = await response.text()
    if (!response.ok) {
      if (request.missingIsNull && response.status === 404) {
        return null
      }
      // An error payload is the server's message about what went wrong, cut to a log line.
      throw new PhotonApiError(response.status, request.method, request.path, describe(body))
    }
    if (body.length === 0) {
      return null
    }
    try {
      return JSON.parse(body)
    } catch {
      // Never echo this body: on a 2xx it can be a freshly minted key, and a log is not where that goes.
      throw new PhotonApiError(
        response.status,
        request.method,
        request.path,
        'the response was not JSON'
      )
    }
  }

  /** A read whose body Orca must understand. A shape it does not know is a refusal, not an empty
   *  result: Beta is a preview, and a silent empty read would look like "no assignments" or "no
   *  project". `null` is only ever a 404 the caller asked to read as absence. */
  private async read<T>(
    credential: PhotonCredential,
    schema: z.ZodType<T>,
    what: string,
    request: Omit<CallRequest, 'what'>
  ): Promise<T | null> {
    const value = await this.call(credential, request)
    return value === null ? null : photonParse(schema, what, value)
  }

  /** A write whose success body Orca reads and must understand: a create answers with the resource. */
  private async created<T>(
    credential: PhotonCredential,
    schema: z.ZodType<T>,
    what: string,
    request: CallRequest
  ): Promise<T> {
    const value = await this.call(credential, request)
    return photonParse(schema, what, value)
  }

  /** A write whose success body Orca does not read. A status Orca did not expect is still reported. */
  private async write(credential: PhotonCredential, request: CallRequest): Promise<void> {
    await this.call(credential, request)
  }
}
