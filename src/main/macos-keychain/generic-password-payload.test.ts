import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  decodeKeychainPayload,
  encodeKeychainPayload,
  writeKeychainPassword
} from './generic-password'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function respond(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, stdout, '')
    return { kill: vi.fn() }
  })
}

beforeEach(() => {
  execFileMock.mockReset()
  setPlatform('darwin')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

// Why a fork-owned file: upstream deleted the suite this used to ride in (its low-value-test audit),
// and these cases guard the Keychain write that once left Claude Code signed out (#134).
describe('keychain payload encoding', () => {
  const stored = JSON.stringify(
    { claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh' } },
    null,
    2
  )

  it('encodes whatever it is handed as hex, which is what `security -X` takes', () => {
    const encoded = encodeKeychainPayload(stored)
    expect(encoded).toMatch(/^(?:[0-9a-f]{2})+$/)
    expect(encoded).not.toContain('\n')
    expect(Buffer.from(encoded, 'hex').toString('utf8')).toBe(stored)
  })

  it('decodes the hex form `security -w` prints for a multi-line value', () => {
    expect(decodeKeychainPayload(`${encodeKeychainPayload(stored)}\n`)).toBe(stored)
  })

  it('leaves a printable item, and anything that is not a payload, alone', () => {
    expect(decodeKeychainPayload('{"claudeAiOauth":{"accessToken":"a"}}')).toBe(
      '{"claudeAiOauth":{"accessToken":"a"}}'
    )
    expect(decodeKeychainPayload('deadbeef')).toBe('deadbeef')
  })

  it('sends the hex form with -X and never the plaintext', async () => {
    setPlatform('darwin')
    respond('')
    await writeKeychainPassword('svc', 'acct', stored)
    const args: string[] = execFileMock.mock.calls[0][1]
    expect(args).toContain('-X')
    expect(args).not.toContain('-w')
    expect(args).not.toContain(stored)
    expect(args.at(-1)).toBe(encodeKeychainPayload(stored))
  })
})
