import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import {
  decodeKeychainPayload,
  encodeKeychainPayload,
  writeKeychainPassword
} from './generic-password'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function exitWith(code: number, stderr = ''): void {
  runProcessMock.mockResolvedValue({
    code,
    signal: null,
    stdout: '',
    stderr,
    timedOut: false,
    outputTruncated: false
  })
}

/** Everything a log or a crash report could print about a rejected write. */
function renderError(error: Error): string {
  return [
    error.message,
    error.stack ?? '',
    JSON.stringify(error, Object.getOwnPropertyNames(error))
  ].join('\n')
}

beforeEach(() => {
  runProcessMock.mockReset()
  setPlatform('darwin')
  exitWith(0)
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
})

describe('keychain writes', () => {
  const stored = JSON.stringify({
    claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh' }
  })

  it('sends the hex payload to `security -i` on stdin and never in argv', async () => {
    await writeKeychainPassword('Claude Code-credentials', 'acct', stored)
    const spec = runProcessMock.mock.calls[0][0]
    const encoded = encodeKeychainPayload(stored)
    expect(spec.program).toBe('/usr/bin/security')
    expect(spec.args).toEqual(['-i'])
    expect(spec.args.join(' ')).not.toContain(encoded)
    expect(spec.input).toBe(
      `add-generic-password -U -s "Claude Code-credentials" -a "acct" -X "${encoded}"\n`
    )
  })

  it('rejects a failed write without the payload or `security` output in the error', async () => {
    const encoded = encodeKeychainPayload(stored)
    exitWith(1, `security: unknown command "${encoded.slice(0, 64)}"`)
    const error = await writeKeychainPassword('svc', 'acct', stored).catch((reason) => reason)
    expect(error.message).toBe('Could not write macOS Keychain item svc/acct.')
    expect(error.code).toBe(1)
    expect(renderError(error)).not.toContain(encoded.slice(0, 16))
    expect(error.stderr).toBeUndefined()
    expect(error.stdout).toBeUndefined()
  })

  it('rejects a spawn failure the same way', async () => {
    const encoded = encodeKeychainPayload(stored)
    runProcessMock.mockRejectedValue(
      Object.assign(new Error(`spawn /usr/bin/security ENOENT ${encoded}`), {
        cmd: `/usr/bin/security -i ${encoded}`
      })
    )
    const error = await writeKeychainPassword('svc', 'acct', stored).catch((reason) => reason)
    expect(error.message).toBe('Could not write macOS Keychain item svc/acct.')
    expect(error.code).toBeUndefined()
    expect(renderError(error)).not.toContain(encoded.slice(0, 16))
  })

  it('falls back to argv for a payload too large for one `security -i` line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const large = JSON.stringify({ claudeAiOauth: { refreshToken: 'r'.repeat(2100) } })
    const encoded = encodeKeychainPayload(large)
    await writeKeychainPassword('svc', 'acct', large)
    const spec = runProcessMock.mock.calls[0][0]
    expect(spec.args.at(-1)).toBe(encoded)
    expect(spec.input).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const warning = String(warn.mock.calls[0][0])
    expect(warning).toContain('exceeds the security -i line limit')
    expect(warning).not.toContain(encoded.slice(0, 16))
    warn.mockRestore()
  })

  it('keeps a line of exactly 4096 bytes on `security -i`, where a longer one is truncated', async () => {
    const atLimit = JSON.stringify({ claudeAiOauth: { refreshToken: 'r'.repeat(1986) } })
    await writeKeychainPassword('svc', 'accts', atLimit)
    const spec = runProcessMock.mock.calls[0][0]
    expect(spec.args).toEqual(['-i'])
    expect(Buffer.byteLength(spec.input)).toBe(4096)
  })

  it('falls back to argv one byte past the `security -i` line limit', async () => {
    const atLimit = JSON.stringify({ claudeAiOauth: { refreshToken: 'r'.repeat(1986) } })
    await writeKeychainPassword('svc', 'acctss', atLimit)
    const spec = runProcessMock.mock.calls[0][0]
    expect(spec.args[0]).toBe('add-generic-password')
    expect(spec.input).toBeUndefined()
  })

  it('rejects an item name that would break the command line', async () => {
    await expect(writeKeychainPassword('a"b', 'acct', stored)).rejects.toThrow(
      'The macOS Keychain item name is invalid.'
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
