import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isManagedPiExtensionInPlace,
  withOrcaManagedPiExtensionMarker,
  writeManagedPiExtension
} from './managed-pi-extension-file'

const FIXED_MTIME = new Date('2020-01-02T03:04:05Z')

function withTempFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orca-managed-pi-extension-'))
  try {
    run(join(dir, 'orca-agent-status.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('withOrcaManagedPiExtensionMarker', () => {
  it('stamps the marker exactly once', () => {
    const once = withOrcaManagedPiExtensionMarker('export default {}\n')
    expect(once).toBe('// @orca-managed-pi-extension\nexport default {}\n')
    expect(withOrcaManagedPiExtensionMarker(once)).toBe(once)
  })
})

describe('writeManagedPiExtension', () => {
  it('creates a missing file', () => {
    withTempFile((path) => {
      expect(writeManagedPiExtension(path, 'managed source')).toBe('written')
      expect(readFileSync(path, 'utf8')).toBe('managed source')
    })
  })

  it('leaves a byte-identical managed file untouched so its mtime survives', () => {
    withTempFile((path) => {
      const source = '// @orca-managed-pi-extension\nmanaged source'
      writeFileSync(path, source)
      utimesSync(path, FIXED_MTIME, FIXED_MTIME)

      expect(writeManagedPiExtension(path, source)).toBe('unchanged')
      expect(statSync(path).mtime.getTime()).toBe(FIXED_MTIME.getTime())
    })
  })

  it('rewrites a managed file whose generated source changed', () => {
    withTempFile((path) => {
      writeFileSync(path, '// @orca-managed-pi-extension\nstale source')
      utimesSync(path, FIXED_MTIME, FIXED_MTIME)

      expect(writeManagedPiExtension(path, '// @orca-managed-pi-extension\nfresh source')).toBe(
        'written'
      )
      expect(readFileSync(path, 'utf8')).toBe('// @orca-managed-pi-extension\nfresh source')
    })
  })

  it('never rewrites a file the user owns', () => {
    withTempFile((path) => {
      writeFileSync(path, 'user-owned extension')
      utimesSync(path, FIXED_MTIME, FIXED_MTIME)

      expect(writeManagedPiExtension(path, '// @orca-managed-pi-extension\nmanaged source')).toBe(
        'skipped-user-owned'
      )
      expect(readFileSync(path, 'utf8')).toBe('user-owned extension')
      expect(statSync(path).mtime.getTime()).toBe(FIXED_MTIME.getTime())
    })
  })

  it('hands a write failure to the caller instead of swallowing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-managed-pi-extension-'))
    try {
      const errors: unknown[] = []
      // No parent directory, so the write fails while the read stays a harmless ENOENT.
      const unreachable = join(dir, 'missing-dir', 'orca-agent-status.ts')

      expect(
        writeManagedPiExtension(unreachable, 'managed source', (error) => errors.push(error))
      ).toBe('failed')
      expect(errors).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isManagedPiExtensionInPlace', () => {
  it('treats both a fresh write and an unchanged file as installed', () => {
    expect(isManagedPiExtensionInPlace('written')).toBe(true)
    expect(isManagedPiExtensionInPlace('unchanged')).toBe(true)
    expect(isManagedPiExtensionInPlace('skipped-user-owned')).toBe(false)
    expect(isManagedPiExtensionInPlace('failed')).toBe(false)
  })
})
