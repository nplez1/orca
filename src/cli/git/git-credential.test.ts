import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { answersCredentialHost, readCredentialRequestHost } from './git-credential'

function request(text: string): Readable {
  return Readable.from([text])
}

describe('orca git-credential', () => {
  it('reads the host git is asking about', async () => {
    const host = await readCredentialRequestHost(
      request('protocol=https\nhost=github.com\npath=nplez1/orca.git\n\n')
    )
    expect(host).toBe('github.com')
  })

  it('stops at the blank line, so a later field cannot change the host', async () => {
    const host = await readCredentialRequestHost(request('host=github.com\n\nhost=gitlab.com\n\n'))
    expect(host).toBe('github.com')
  })

  it('answers only for the host the App acts on', () => {
    expect(answersCredentialHost('github.com')).toBe(true)
    expect(answersCredentialHost('gitlab.com')).toBe(false)
    expect(answersCredentialHost('github.example.com')).toBe(false)
  })

  it('answers a request that names no host, which some git callers omit', () => {
    expect(answersCredentialHost(undefined)).toBe(true)
  })
})
