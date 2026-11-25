// macOS names an app "Intel-based" when any component it runs is x86_64-only, and Rosetta goes away
// after macOS 27 (#101). Census every Mach-O so a slice that lacks the build's arch fails packaging.
const { closeSync, openSync, readSync, readdirSync } = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')

const CPU_ARCH_NAMES = new Map([
  [0x01000007, 'x64'],
  [0x0100000c, 'arm64']
])
const HEADER_BYTES = 8 + 20 * 32
// MH_OBJECT and MH_DSYM are never loaded, so a stale build slice there is not a runtime component.
const UNLOADED_FILE_TYPES = new Set([0x1, 0xa])

/** The CPU types a Mach-O header declares, or null when the bytes are not Mach-O. */
function machOArchitectures(header) {
  if (header.length < 8) {
    return null
  }
  const magicBE = header.readUInt32BE(0)
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const count = header.readUInt32BE(4)
    // Java class files share 0xcafebabe; their next word is a class version >= 45.
    const entryBytes = magicBE === 0xcafebabf ? 32 : 20
    if (count === 0 || count >= 45 || header.length < 8 + count * entryBytes) {
      return null
    }
    return Array.from({ length: count }, (_, i) =>
      archName(header.readUInt32BE(8 + i * entryBytes))
    )
  }
  const magicLE = header.readUInt32LE(0)
  const isThinBE = magicBE === 0xfeedface || magicBE === 0xfeedfacf
  if (!isThinBE && magicLE !== 0xfeedface && magicLE !== 0xfeedfacf) {
    return null
  }
  const word = (offset) => (isThinBE ? header.readUInt32BE(offset) : header.readUInt32LE(offset))
  if (header.length < 16 || UNLOADED_FILE_TYPES.has(word(12))) {
    return null
  }
  return [archName(word(4))]
}

function archName(cpuType) {
  return CPU_ARCH_NAMES.get(cpuType) ?? `cpu 0x${cpuType.toString(16)}`
}

function readHeader(path) {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(HEADER_BYTES)
    return header.subarray(0, readSync(fd, header, 0, HEADER_BYTES, 0))
  } finally {
    closeSync(fd)
  }
}

/** The darwin arch a path is scoped to (`ripgrep/darwin-x64/rg`, `watcher-darwin-arm64`), if any. */
function scopedDarwinArch(relativePath) {
  return relativePath.match(/darwin[-_](x64|arm64)(?![a-z0-9+])/)?.[1] ?? null
}

// Not readdirSync({ recursive }): it follows framework `Versions/Current` symlinks and counts files twice.
function* regularFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* regularFiles(path)
    } else if (entry.isFile()) {
      yield path
    }
  }
}

/**
 * Each Mach-O must carry the build's arch, except payloads named for one darwin arch (shipped for
 * remote hosts), which must carry that arch instead.
 */
function findMacArchitectureProblems(appPath, targetArch) {
  const problems = []
  let checked = 0
  for (const path of regularFiles(appPath)) {
    const archs = machOArchitectures(readHeader(path))
    if (!archs) {
      continue
    }
    checked += 1
    const relativePath = relative(appPath, path).split(sep).join('/')
    const required = scopedDarwinArch(relativePath) ?? targetArch
    if (!archs.includes(required)) {
      problems.push(`${relativePath} has ${archs.join(',')}, expected ${required}`)
    }
  }
  return { checked, problems: problems.sort() }
}

function verifyPackagedMacArchitectures(appPath, targetArch) {
  const { checked, problems } = findMacArchitectureProblems(appPath, targetArch)
  if (problems.length > 0) {
    throw new Error(
      `[verify-packaged-mac-architectures] ${problems.length} Mach-O file(s) cannot run natively ` +
        `in this ${targetArch} app:\n  ${problems.join('\n  ')}`
    )
  }
  console.log(
    `[verify-packaged-mac-architectures] OK — ${checked} Mach-O file(s) carry ${targetArch} or their scoped arch`
  )
}

module.exports = {
  findMacArchitectureProblems,
  machOArchitectures,
  verifyPackagedMacArchitectures
}

// Usage: node verify-packaged-mac-architectures.cjs "/Applications/Orca NP.app" arm64
if (require.main === module) {
  const [appPath, targetArch] = process.argv.slice(2)
  if (!appPath || !['x64', 'arm64'].includes(targetArch)) {
    console.error('usage: verify-packaged-mac-architectures.cjs <App.app> <x64|arm64>')
    process.exit(2)
  }
  try {
    verifyPackagedMacArchitectures(resolve(appPath), targetArch)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
