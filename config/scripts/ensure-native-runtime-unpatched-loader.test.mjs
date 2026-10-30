import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  envForNativeFixture,
  mkTempProject,
  writeFakeNodeGyp
} from './ensure-native-runtime-fixture.mjs'

describe('ensure-native-runtime unpatched node-pty loader', () => {
  it.skipIf(process.platform === 'win32').each([
    { label: 'without flags', extraArgs: [] },
    { label: 'with --force', extraArgs: ['--force'] }
  ])(
    'fails fast on a node-pty from another store, $label, instead of retrying a rebuild that cannot help',
    ({ extraArgs }) => {
      const projectDir = mkTempProject()
      const foreignStoreDir = mkTempProject()
      const declaredStoreDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        const markerPath = join(projectDir, 'rebuilt.marker')
        writeNodePtyPatchFile(projectDir)
        writeForeignStoreNodePty(projectDir, foreignStoreDir, { declaredStore: declaredStoreDir })
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node', ...extraArgs], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: markerPath
          })
        })

        expect(result.status, result.stderr).toBe(1)
        expect(result.stderr).toContain("is not Orca's patched copy")
        expect(result.stderr).toContain(`never looks in the build/orca-napi-${process.platform}-`)
        expect(result.stderr).toContain('different pnpm store')
        expect(result.stderr).toContain(`--store-dir '${declaredStoreDir}'`)
        expect(result.stderr).not.toContain('Native modules still do not load')
        expect(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').not.toContain(
          'node-gyp rebuild'
        )
        expect(existsSync(markerPath)).toBe(false)
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
        rmSync(foreignStoreDir, { recursive: true, force: true })
        rmSync(declaredStoreDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'blames skipped patches, not the store, when the copy is not shared from it',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        writeNodePtyPatchFile(projectDir)
        writeUnpatchedNodePtyLoader(projectDir, { declaredStore: join(projectDir, 'node_modules') })

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: join(projectDir, 'native-runtime.log'),
            ORCA_NATIVE_TEST_MARKER: join(projectDir, 'rebuilt.marker')
          })
        })

        expect(result.status, result.stderr).toBe(1)
        expect(result.stderr).toContain("pnpm did not apply Orca's node-pty patch")
        expect(result.stderr).not.toContain('different pnpm store')
        expect(result.stderr).not.toContain('--store-dir')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drops the store remedy when node_modules records no readable store',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        writeNodePtyPatchFile(projectDir)
        writeUnpatchedNodePtyLoader(projectDir)
        writeFileSync(join(projectDir, 'node_modules', '.modules.yaml'), '{ not json')

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: join(projectDir, 'native-runtime.log'),
            ORCA_NATIVE_TEST_MARKER: join(projectDir, 'rebuilt.marker')
          })
        })

        expect(result.status, result.stderr).toBe(1)
        expect(result.stderr).toContain("pnpm did not apply Orca's node-pty patch")
        expect(result.stderr).not.toContain('--store-dir')
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves a checkout without the node-pty patch file alone',
    () => {
      const projectDir = mkTempProject()

      try {
        const scriptPath = join(projectDir, 'config', 'scripts', 'ensure-native-runtime.mjs')
        const logPath = join(projectDir, 'native-runtime.log')
        writeUnpatchedNodePtyLoader(projectDir)
        writeFakeNodeGyp(projectDir)

        const result = spawnSync(process.execPath, [scriptPath, '--runtime=node'], {
          cwd: projectDir,
          encoding: 'utf8',
          env: envForNativeFixture(projectDir, {
            ORCA_NATIVE_TEST_LOG: logPath,
            ORCA_NATIVE_TEST_MARKER: join(projectDir, 'rebuilt.marker')
          })
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stderr).not.toContain("is not Orca's patched copy")
        expect(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').not.toContain(
          'node-gyp rebuild'
        )
      } finally {
        rmSync(projectDir, { recursive: true, force: true })
      }
    }
  )
})

function writeNodePtyPatchFile(projectDir) {
  mkdirSync(join(projectDir, 'config', 'patches'), { recursive: true })
  writeFileSync(join(projectDir, 'config', 'patches', 'node-pty@1.1.0.patch'), 'patch marker\n')
}

// Mirrors a global-virtual-store install: the package lives in another store, linked in from there.
function writeForeignStoreNodePty(projectDir, storeDir, { declaredStore }) {
  const storePtyDir = join(storeDir, 'links', '@', 'node-pty', 'node_modules', 'node-pty')
  writeUnpatchedNodePtyPackage(storePtyDir)
  mkdirSync(join(projectDir, 'node_modules'), { recursive: true })
  symlinkSync(storePtyDir, join(projectDir, 'node_modules', 'node-pty'), 'junction')
  writeFileSync(
    join(projectDir, 'node_modules', '.modules.yaml'),
    JSON.stringify({ storeDir: declaredStore }, null, 2)
  )
}

// An upstream copy: no per-ABI slot lookup, so Orca's patch can never be active.
function writeUnpatchedNodePtyLoader(projectDir, { declaredStore = null } = {}) {
  writeUnpatchedNodePtyPackage(join(projectDir, 'node_modules', 'node-pty'))
  if (declaredStore) {
    writeFileSync(
      join(projectDir, 'node_modules', '.modules.yaml'),
      JSON.stringify({ storeDir: declaredStore }, null, 2)
    )
  }
}

function writeUnpatchedNodePtyPackage(nodePtyDir) {
  mkdirSync(join(nodePtyDir, 'lib'), { recursive: true })
  mkdirSync(join(nodePtyDir, 'scripts'), { recursive: true })
  writeFileSync(join(nodePtyDir, 'scripts', 'post-install.js'), '')
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = {}\n')
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    '{"name":"node-pty","version":"1.1.0","main":"index.js"}\n'
  )
  writeFileSync(
    join(nodePtyDir, 'lib', 'utils.js'),
    `
const { appendFileSync } = require('node:fs')

exports.loadNativeModule = function loadNativeModule(nativeName) {
  const dir = '../prebuilds/' + process.platform + '-' + process.arch + '/'
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-pty load \${nativeName} dir=\${dir}\\n\`)
  return {
    dir,
    module: {
      listJobProcessIds: () => [],
      terminateJob: () => true,
      assignCurrentProcessToJob: () => true,
      assignCurrentProcessToStrictJob: () => true
    }
  }
}
`
  )
}
