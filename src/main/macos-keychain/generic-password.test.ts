import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  decodeKeychainPayload,
  encodeKeychainPayload,
  isKeychainNotFoundError,
  readKeychainPassword,
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

function fail(error: unknown): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(error, '', '')
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

describe('readKeychainPassword', () => {
  it('returns the trimmed secret for a stored item', async () => {
    respond('  secret-value\n')
    await expect(readKeychainPassword('cursor-access-token', 'cursor-user')).resolves.toBe(
      'secret-value'
    )
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'find-generic-password',
      '-s',
      'cursor-access-token',
      '-a',
      'cursor-user',
      '-w'
    ])
  })

  it('returns null rather than throwing when the item does not exist', async () => {
    fail(Object.assign(new Error('The specified item could not be found'), { code: 44 }))
    await expect(readKeychainPassword('svc', 'acct')).resolves.toBeNull()
  })

  it('rethrows a denied or locked keychain so callers can report it', async () => {
    fail(new Error('User interaction is not allowed'))
    await expect(readKeychainPassword('svc', 'acct')).rejects.toThrow(
      'User interaction is not allowed'
    )
  })

  it('never shells out off macOS', async () => {
    setPlatform('win32')
    await expect(readKeychainPassword('svc', 'acct')).resolves.toBeNull()
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('isKeychainNotFoundError', () => {
  it('recognizes the security(1) not-found signals', () => {
    expect(isKeychainNotFoundError({ code: 44 })).toBe(true)
    expect(isKeychainNotFoundError(new Error('The specified item could not be found'))).toBe(true)
    expect(isKeychainNotFoundError(new Error('User interaction is not allowed'))).toBe(false)
  })
})

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
