import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { findMacArchitectureProblems } = require('./verify-packaged-mac-architectures.cjs')

const X64 = 0x01000007
const ARM64 = 0x0100000c

const MH_EXECUTE = 0x2
const MH_OBJECT = 0x1

function thin(cpuType, fileType = MH_EXECUTE) {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpuType, 4)
  header.writeUInt32LE(fileType, 12)
  return header
}

function fat(cpuTypes, { is64 = false } = {}) {
  const entryBytes = is64 ? 32 : 20
  const header = Buffer.alloc(8 + cpuTypes.length * entryBytes)
  header.writeUInt32BE(is64 ? 0xcafebabf : 0xcafebabe, 0)
  header.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpuType, i) => header.writeUInt32BE(cpuType, 8 + i * entryBytes))
  return header
}

let root
afterEach(() => rmSync(root, { recursive: true, force: true }))

function app(files) {
  root = mkdtempSync(join(tmpdir(), 'orca-mac-arch-census-'))
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  return root
}

describe('findMacArchitectureProblems', () => {
  it('holds each loadable Mach-O to the app arch, or to the darwin arch its path names', () => {
    const appPath = app({
      'Contents/MacOS/Orca NP': thin(ARM64),
      'Contents/MacOS/helper-universal': fat([X64, ARM64]),
      'Contents/MacOS/helper-universal-64': fat([X64, ARM64], { is64: true }),
      'Contents/MacOS/helper-intel-64': fat([X64], { is64: true }),
      'Contents/Resources/ripgrep/darwin-x64/rg': thin(X64),
      'Contents/Resources/ripgrep/darwin-x64-alt/rg': thin(ARM64),
      'Contents/Resources/ripgrep/darwin-arm64/rg': thin(X64),
      'Contents/Resources/intel-only-cli': thin(X64),
      'Contents/Resources/build/obj.target/pty.o': thin(X64, MH_OBJECT),
      // Java class files share the fat magic; their version word is >= 45.
      'Contents/Resources/Main.class': Buffer.from('cafebabe00000034', 'hex'),
      'Contents/Resources/readme.txt': Buffer.from('not a binary')
    })
    mkdirSync(join(appPath, 'Contents/Frameworks/X.framework/Versions/A'), { recursive: true })
    writeFileSync(join(appPath, 'Contents/Frameworks/X.framework/Versions/A/X'), thin(X64))
    symlinkSync('A', join(appPath, 'Contents/Frameworks/X.framework/Versions/Current'))

    expect(findMacArchitectureProblems(appPath, 'arm64')).toEqual({
      checked: 9,
      problems: [
        'Contents/Frameworks/X.framework/Versions/A/X has x64, expected arm64',
        'Contents/MacOS/helper-intel-64 has x64, expected arm64',
        'Contents/Resources/intel-only-cli has x64, expected arm64',
        'Contents/Resources/ripgrep/darwin-arm64/rg has x64, expected arm64',
        'Contents/Resources/ripgrep/darwin-x64-alt/rg has arm64, expected x64'
      ]
    })
  })
})
