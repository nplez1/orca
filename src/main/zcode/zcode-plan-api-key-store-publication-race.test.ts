import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_DIRECTORY_NAME } from '../../shared/app-directory-names'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import type * as Fs from 'node:fs'
import type * as SecureFile from '../../shared/secure-file'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const restriction = vi.hoisted(() => vi.fn((_path: string, _directory: boolean) => false))

// Why a plain object and not vi.fn mocks: these rollback tests never assert on the
// sealing calls — they force the plaintext path so the store's rollback is what runs.
const secretStoreMock = {
  isEncryptionAvailable: () => false,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString('utf8'),
  describeProtectionGap: () => null
}

// Stands in for the born-restricted create: a real staged write, then the injected outcome.
vi.mock('../../shared/secure-path-windows-acl', async () => {
  const { writeFileSync: stage } = await vi.importActual<typeof Fs>('node:fs')
  return {
    restrictWindowsPathSync: restriction,
    bestEffortRestrictWindowsPath: (
      _path: string,
      _directory: boolean,
      settled: (restricted: boolean) => void
    ) => settled(false),
    resetSecureFileWindowsUserSidForTests: vi.fn(),
    writeRestrictedWindowsFile: (path: string, contents: string) => {
      stage(path, contents, { encoding: 'utf-8', mode: 0o600 })
      return restriction(path, false)
    },
    restrictWindowsDirectory: () => Promise.resolve(false)
  }
})

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const envelope = (key: string): string =>
  `orca-zcode-plan-api-key:v1:plaintext:${Buffer.from(key).toString('base64')}`
const previousEnvelope = envelope('previous-key')
const competingEnvelope = envelope('competing-key')
const readStoreFiles = (): string[] =>
  readdirSync(join(caseHome, HOME_DIRECTORY_NAME)).filter((entry) => entry !== '.adopted')
let caseHome: string
let keyPath: string
let store: typeof ZcodePlanApiKeyStore
let writer: typeof SecureFile

beforeEach(async () => {
  caseHome = mkdtempSync(join(tmpdir(), 'orca-rollback-publication-'))
  vi.stubEnv('HOME', caseHome)
  vi.stubEnv('USERPROFILE', caseHome)
  keyPath = join(caseHome, HOME_DIRECTORY_NAME, 'zcode-plan-api-key.enc')
  mkdirSync(join(caseHome, HOME_DIRECTORY_NAME, '.adopted'), { recursive: true })
  writeFileSync(join(caseHome, HOME_DIRECTORY_NAME, '.adopted', 'zcode-plan-api-key.enc'), '')
  restriction.mockReset().mockReturnValue(false)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  vi.resetModules()
  expect(homedir()).toBe(caseHome)
  setSecretStore(secretStoreMock)
  store = await import('./zcode-plan-api-key-store')
  writer = await import('../../shared/secure-file')
  expect(vi.isMockFunction(writer.writeSecureFile)).toBe(false)
  expect(vi.isMockFunction(writeFileSync)).toBe(false)
  expect(vi.isMockFunction(renameSync)).toBe(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  _resetSecretStoreForTests()
  vi.restoreAllMocks()
  rmSync(caseHome, { recursive: true, force: true })
})

function publishDuringRollbackStaging(outcome: boolean | 'throws'): void {
  let stagedRestrictions = 0
  restriction.mockImplementation((targetPath) => {
    if (targetPath.endsWith('.tmp') && ++stagedRestrictions === 2) {
      const competingPath = join(caseHome, HOME_DIRECTORY_NAME, 'competing-envelope')
      writeFileSync(competingPath, competingEnvelope)
      renameSync(competingPath, keyPath)
      if (outcome === 'throws') {
        throw new Error('Synthetic rollback staged ACL failure')
      }
      return outcome
    }
    return false
  })
}

function refuseReplacement(): void {
  expect(() => store.saveZcodePlanApiKey('attempted-key')).toThrow(
    'could not be stored securely on this device'
  )
}

describe('rollback publication with real filesystem writes and renames', () => {
  it.each([false, true, 'throws'] as const)(
    'preserves the competing publication when the second staged ACL call returns %s',
    (outcome) => {
      writeFileSync(keyPath, previousEnvelope)
      publishDuringRollbackStaging(outcome)

      refuseReplacement()

      expect(readFileSync(keyPath, 'utf8')).toBe(competingEnvelope)
      expect(readFileSync(keyPath, 'utf8')).not.toBe(envelope('attempted-key'))
      expect(store.readZcodePlanApiKey()).toBe('competing-key')
      expect(readStoreFiles()).toEqual(['zcode-plan-api-key.enc'])
    }
  )

  it('restores the previous envelope when the attempted publication is still owned', () => {
    writeFileSync(keyPath, previousEnvelope)

    refuseReplacement()

    expect(readFileSync(keyPath, 'utf8')).toBe(previousEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    expect(readStoreFiles()).toEqual(['zcode-plan-api-key.enc'])
  })

  it('removes the owned rejected plaintext when no previous envelope exists', () => {
    refuseReplacement()

    expect(existsSync(keyPath)).toBe(false)
    expect(store.readZcodePlanApiKey()).toBeNull()
    expect(readStoreFiles()).toEqual([])
  })

  it.each([false, true])(
    'retains the prior target state when initial staged hardening throws: previous %s',
    (previous) => {
      if (previous) {
        writeFileSync(keyPath, previousEnvelope)
      }
      restriction.mockImplementation((targetPath) => {
        if (targetPath.endsWith('.tmp')) {
          throw new Error('Synthetic initial staged ACL failure')
        }
        return false
      })

      expect(() => store.saveZcodePlanApiKey('attempted-key')).toThrow(
        'Synthetic initial staged ACL failure'
      )

      expect(existsSync(keyPath)).toBe(previous)
      expect(store.readZcodePlanApiKey()).toBe(previous ? 'previous-key' : null)
      expect(readStoreFiles()).toEqual(previous ? ['zcode-plan-api-key.enc'] : [])
      if (previous) {
        expect(readFileSync(keyPath, 'utf8')).toBe(previousEnvelope)
      }
    }
  )

  it('keeps the cached prior key after rejecting a replacement during competing publication', () => {
    writeFileSync(keyPath, previousEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    publishDuringRollbackStaging(false)

    refuseReplacement()

    expect(readFileSync(keyPath, 'utf8')).toBe(competingEnvelope)
    expect(store.readZcodePlanApiKey()).toBe('previous-key')
    expect(readStoreFiles()).toEqual(['zcode-plan-api-key.enc'])
  })
})
