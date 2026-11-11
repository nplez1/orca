import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { PROJECT_HANDLERS } from './project'

type Call = { method: string; params: unknown }

function stubClient(args: { home?: string; remote?: boolean } = {}): {
  client: RuntimeClient
  calls: Call[]
} {
  const calls: Call[] = []
  const client = {
    isRemote: args.remote === true,
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'files.browseServerDir') {
        return { result: { resolvedPath: args.home ?? '/home/me' } }
      }
      if (method === 'project.list') {
        return { result: { projects: [] } }
      }
      if (method === 'projectHostSetup.clone') {
        return {
          result: {
            result: {
              setup: { id: 'setup-1', projectId: 'github:o/r', hostId: 'local', path: '/x' }
            }
          }
        }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls isRemote and call().
  return { client: client as unknown as RuntimeClient, calls }
}

function flags(entries: Record<string, string>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

const handler = PROJECT_HANDLERS['project setup-clone']

describe('orca project setup-clone', () => {
  it('defaults the destination to the host’s repository root convention', async () => {
    const { client, calls } = stubClient({ home: '/home/me' })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await handler({
      flags: flags({ project: 'github:o/r', host: 'local', url: 'https://example.test/o/r.git' }),
      client,
      cwd: '/work',
      json: true
    })
    output.mockRestore()
    const clone = calls.find((call) => call.method === 'projectHostSetup.clone')
    expect(clone?.params).toMatchObject({ destination: '/home/me/orca/projects' })
  })

  it('keeps an explicit destination exactly as given', async () => {
    const { client, calls } = stubClient({ home: '/home/me' })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await handler({
      flags: flags({
        project: 'github:o/r',
        host: 'local',
        url: 'https://example.test/o/r.git',
        destination: '/srv/src'
      }),
      client,
      cwd: '/work',
      json: true
    })
    output.mockRestore()
    const clone = calls.find((call) => call.method === 'projectHostSetup.clone')
    expect(clone?.params).toMatchObject({ destination: '/srv/src' })
    expect(calls.some((call) => call.method === 'files.browseServerDir')).toBe(false)
  })

  it('resolves the convention on the server it is routed to', async () => {
    const { client, calls } = stubClient({ home: '/srv/users/me', remote: true })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await handler({
      flags: flags({
        project: 'github:o/r',
        host: 'runtime:server-a',
        url: 'https://example.test/o/r.git'
      }),
      client,
      cwd: '/work',
      json: true
    })
    output.mockRestore()
    const clone = calls.find((call) => call.method === 'projectHostSetup.clone')
    expect(clone?.params).toMatchObject({ destination: '/srv/users/me/orca/projects' })
  })
})
