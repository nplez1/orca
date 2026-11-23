import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  answersCredentialRequest,
  answerGitCredentialRequest,
  readCredentialRequest
} from './git-credential'

function request(text: string): Readable {
  return Readable.from([text])
}

/** git's request for the project's own repository, which is the one the App can answer. */
const OWN_REPO = 'protocol=https\nhost=github.com\npath=nplez1/orca.git\n\n'

async function read(text: string): Promise<Record<string, string>> {
  return await readCredentialRequest(request(text))
}

describe('orca git-credential', () => {
  it('reads git’s request as fields', async () => {
    expect(await read(OWN_REPO)).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: 'nplez1/orca.git'
    })
  })

  it('stops at the blank line, so a later field cannot change the request', async () => {
    expect(await read('host=github.com\n\nhost=gitlab.com\n\n')).toEqual({ host: 'github.com' })
  })

  it('answers only an https request naming a github.com repository', () => {
    expect(
      answersCredentialRequest({ protocol: 'https', host: 'github.com', path: 'o/r.git' })
    ).toBe(true)
    expect(
      answersCredentialRequest({ protocol: 'https', host: 'gitlab.com', path: 'o/r.git' })
    ).toBe(false)
    expect(
      answersCredentialRequest({ protocol: 'https', host: 'github.example.com', path: 'o/r.git' })
    ).toBe(false)
  })

  it('makes no RPC call and prints nothing when git names no repository, no host, or another host', async () => {
    const requests = [
      'protocol=https\nhost=gitlab.com\npath=nplez1/orca.git\n\n',
      'protocol=https\npath=nplez1/orca.git\n\n',
      'protocol=https\nhost=github.com\n\n',
      'protocol=http\nhost=github.com\npath=nplez1/orca.git\n\n'
    ]
    for (const text of requests) {
      const call = vi.fn(async () => ({ username: 'x', password: 'y' }))
      const write = vi.fn()
      await answerGitCredentialRequest({
        request: await read(text),
        folder: '/repo',
        call,
        write
      })
      expect(call).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    }
  })

  it('hands git the App’s login and token, naming the repository git asked about', async () => {
    const call = vi.fn(async () => ({ username: 'lab-agent-np[bot]', password: 'ghs_token' }))
    const write = vi.fn()
    await answerGitCredentialRequest({
      request: await read(OWN_REPO),
      folder: '/repo',
      call,
      write
    })
    expect(call).toHaveBeenCalledWith({ repo: 'path:/repo', path: 'nplez1/orca.git' })
    expect(write).toHaveBeenCalledWith('username=lab-agent-np[bot]\npassword=ghs_token\n')
  })
})
