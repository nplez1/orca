// A fake Photon Beta API: a real HTTP server on a loopback port, so the client is exercised through
// actual requests, real status codes and real idempotency replay rather than a mock that cannot fail.
// It models the parts of the endpoint table this fork reads, and every knob here exists because a test
// needs to make that step fail.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { normaliseHandle } from './photon-fake-server.handles'
import type {
  FakeAssignment,
  FakeMessage,
  FakePhotonState,
  FakeProject
} from './photon-fake-server.state'
export type { FakeAssignment, FakeMessage, FakePhotonState, FakeProject }

export type FakePhotonServer = {
  baseUrl: string
  state: FakePhotonState
  close: () => Promise<void>
  /** A response the server never produced, for asserting a refusal path. */
  injectRaw: (method: string, path: string, status: number, body: string) => void
}

let counter = 0
const nextId = (prefix: string): string => `${prefix}_${(counter += 1).toString(36)}`

/** Photon names a project's id `projectId` on the wire; the fake says what the real one says. */
const wireProject = (project: FakeProject): Record<string, unknown> => ({
  projectId: project.id,
  slug: project.slug,
  name: project.name,
  organizationId: project.organizationId
})

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    request.on('error', reject)
  })
}

export async function startFakePhotonServer(): Promise<FakePhotonServer> {
  const state: FakePhotonState = {
    projects: new Map(),
    idempotency: new Map(),
    keys: new Map(),
    assignments: new Map(),
    sent: [],
    requests: [],
    closureReadsRemaining: 0,
    deleted: []
  }
  const raw = new Map<string, { status: number; body: string }>()

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(text)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/v1/, '')
    state.requests.push(`${method} ${path}`)
    const injected = raw.get(`${method} ${path}`)
    if (injected) {
      raw.delete(`${method} ${path}`)
      send(response, injected.status, injected.body)
      return
    }
    const body = await readBody(request)
    const json = parseJsonObject(body)
    const idempotencyKey =
      typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined

    const parts = path.split('/').filter(Boolean)

    // POST /organizations/:id/projects
    if (method === 'POST' && parts[0] === 'organizations' && parts[2] === 'projects') {
      const slug = String(json.slug ?? '')
      const replay = idempotencyKey ? state.idempotency.get(`project:${idempotencyKey}`) : undefined
      if (replay) {
        const existing = state.projects.get(replay)
        if (existing) {
          send(response, 200, wireProject(existing))
          return
        }
      }
      const bySlug = [...state.projects.values()].find((project) => project.slug === slug)
      if (bySlug) {
        // The slug is immutable and cannot be reused: a second create under it is a conflict.
        send(response, 409, { error: 'slug_taken' })
        return
      }
      const project: FakeProject = {
        id: nextId('pho_prj'),
        slug,
        name: String(json.name ?? ''),
        organizationId: parts[1] ?? 'org'
      }
      state.projects.set(project.id, project)
      if (idempotencyKey) {
        state.idempotency.set(`project:${idempotencyKey}`, project.id)
      }
      send(response, 201, wireProject(project))
      return
    }

    // GET /organizations/:id/projects — how a taken slug is looked up rather than retried forever.
    if (method === 'GET' && parts[0] === 'organizations' && parts[2] === 'projects') {
      send(response, 200, {
        projects: [...state.projects.values()]
          .filter((project) => project.organizationId === parts[1])
          .map(wireProject)
      })
      return
    }

    // GET|DELETE /projects/:id  and  /projects/:id/closure
    if (parts[0] === 'projects' && parts.length === 2) {
      const project = state.projects.get(parts[1] ?? '')
      if (!project) {
        send(response, 404, { error: 'not_found' })
        return
      }
      if (method === 'GET') {
        send(response, 200, wireProject(project))
        return
      }
      state.deleted.push(project.id)
      state.closureReadsRemaining = state.closureReadsRemaining || 2
      send(response, 202, { state: 'closing' })
      return
    }
    if (parts[0] === 'projects' && parts[2] === 'closure') {
      const project = state.projects.get(parts[1] ?? '')
      if (!project) {
        send(response, 404, { error: 'not_found' })
        return
      }
      if (state.closureReadsRemaining > 0) {
        state.closureReadsRemaining -= 1
        send(response, 200, { state: 'closing' })
        return
      }
      state.projects.delete(project.id)
      send(response, 200, { state: 'closed' })
      return
    }

    // POST /projects/:id/keys
    if (method === 'POST' && parts[0] === 'projects' && parts[2] === 'keys') {
      if (state.failNextKeyMint) {
        const status = state.failNextKeyMint
        state.failNextKeyMint = undefined
        send(response, status, { error: 'injected' })
        return
      }
      const replay = idempotencyKey ? state.idempotency.get(`key:${idempotencyKey}`) : undefined
      if (replay) {
        const existing = state.keys.get(replay)
        if (existing) {
          send(response, 200, { apiKey: { apiKeyId: replay }, secret: existing.secret })
          return
        }
      }
      const id = nextId('pho_key')
      const secret = `pho_sk_${id}`
      state.keys.set(id, { projectId: parts[1] ?? '', secret, revoked: false })
      if (idempotencyKey) {
        state.idempotency.set(`key:${idempotencyKey}`, id)
      }
      send(response, 201, { apiKey: { apiKeyId: id }, secret })
      return
    }
    if (method === 'DELETE' && parts[0] === 'projects' && parts[2] === 'keys') {
      const key = state.keys.get(parts[3] ?? '')
      if (!key) {
        send(response, 404, { error: 'not_found' })
        return
      }
      key.revoked = true
      send(response, 204, {})
      return
    }

    // assignments
    if (parts[0] === 'projects' && parts[2] === 'platforms' && parts[3] === 'imessage') {
      const projectId = parts[1] ?? ''
      if (parts[4] === 'assignments' && method === 'GET') {
        send(response, 200, {
          assignments: [...state.assignments.values()]
            .filter((entry) => entry.projectId === projectId)
            .map(({ id, handle, assignedPhoneNumber }) => ({ id, handle, assignedPhoneNumber }))
        })
        return
      }
      if (parts[4] === 'assignments' && method === 'POST') {
        if (state.failNextAssignment) {
          const status = state.failNextAssignment
          state.failNextAssignment = undefined
          send(response, status, { error: 'injected' })
          return
        }
        const handle = String(json.handle ?? '')
        const replay = idempotencyKey
          ? state.idempotency.get(`assign:${idempotencyKey}`)
          : undefined
        if (replay) {
          const existing = state.assignments.get(replay)
          if (existing) {
            send(response, 200, {
              id: existing.id,
              handle: existing.handle,
              assignedPhoneNumber: existing.assignedPhoneNumber
            })
            return
          }
        }
        const id = nextId('pho_asn')
        const assignment = {
          id,
          // The provider normalises a handle before assigning it, so a typed `(555) 123-4567` comes
          // back as `+15551234567`. A fake that echoed the input could not catch Orca comparing the two.
          handle: normaliseHandle(handle),
          assignedPhoneNumber: `+1555${String(1000 + state.assignments.size)}`,
          projectId
        }
        state.assignments.set(id, assignment)
        if (idempotencyKey) {
          state.idempotency.set(`assign:${idempotencyKey}`, id)
        }
        send(response, 201, {
          id,
          handle: assignment.handle,
          assignedPhoneNumber: assignment.assignedPhoneNumber
        })
        return
      }
      if (parts[4] === 'assignments' && method === 'DELETE') {
        if (!state.assignments.delete(parts[5] ?? '')) {
          send(response, 404, { error: 'not_found' })
          return
        }
        send(response, 204, {})
        return
      }
      if (parts[4] === 'messages' && method === 'POST') {
        if (state.failNextSend) {
          const status = state.failNextSend
          state.failNextSend = undefined
          send(response, status, { error: 'injected' })
          return
        }
        // A replayed Idempotency-Key is the same message, not a second one: that is what makes keying a
        // send on the answer's text rather than on the turn lose the second answer.
        if (idempotencyKey) {
          const replay = state.idempotency.get(`send:${idempotencyKey}`)
          if (replay) {
            send(response, 202, { accepted: true, id: replay })
            return
          }
          const id = nextId('pho_msg')
          state.idempotency.set(`send:${idempotencyKey}`, id)
          state.sent.push({
            conversationId: String(json.conversationId ?? ''),
            text: String(json.text ?? ''),
            idempotencyKey,
            id
          })
          send(response, 202, { accepted: true, id })
          return
        }
        state.sent.push({
          conversationId: String(json.conversationId ?? ''),
          text: String(json.text ?? ''),
          idempotencyKey
        })
        send(response, 202, { accepted: true })
        return
      }
    }

    send(response, 404, { error: 'unhandled', path })
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('the fake Photon server did not get a loopback port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    injectRaw: (method, path, status, body) => raw.set(`${method} ${path}`, { status, body })
  }
}

/** A request body as a JSON object; anything else reads as no fields rather than failing the server. */
function parseJsonObject(body: string): Record<string, unknown> {
  if (body.length === 0) {
    return {}
  }
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }
  return Object.fromEntries(Object.entries(parsed))
}
