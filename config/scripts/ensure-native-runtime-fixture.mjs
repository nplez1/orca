// Shared harness for the ensure-native-runtime suites: a temp project that runs the real script.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyScriptWithLocalModules } from './script-module-dependencies.mjs'

const sourceScriptPath = fileURLToPath(new URL('./ensure-native-runtime.mjs', import.meta.url))
// Fixture import walk misses createRequire CJS edges; name siblings explicitly or temp project cannot load.
const REQUIRED_CJS_SIBLINGS = [
  'node-pty-job-ownership.cjs',
  'windows-process-tree-creation-time.cjs'
]

export function mkTempProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'orca-native-runtime-'))
  // Copy walked windows-process-tree-gyp-rebuild dependency or every case fails before its intended check.
  copyScriptWithLocalModules(sourceScriptPath, join(projectDir, 'config', 'scripts'))
  const processPackage = join(projectDir, 'node_modules', '@orca', 'process-host')
  mkdirSync(processPackage, { recursive: true })
  writeFileSync(
    join(processPackage, 'package.json'),
    JSON.stringify({ name: '@orca/process-host', type: 'module', exports: './index.mjs' })
  )
  writeFileSync(
    join(processPackage, 'index.mjs'),
    `import { appendFileSync } from 'node:fs'
import { runProcessSync as run } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('@orca/process-host')).href)}
export function runProcessSync(options) {
  appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-gyp timeout=\${options.timeoutMs}\\n\`)
  return run(options)
}
`
  )
  for (const name of REQUIRED_CJS_SIBLINGS) {
    copyFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      join(projectDir, 'config', 'scripts', name)
    )
  }
  return projectDir
}

export function envForNativeFixture(projectDir, extraEnv) {
  // An inherited tracking preference would mask the Windows default under test.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'trackfileaccess')
  )
  return {
    ...inherited,
    ...extraEnv,
    npm_config_node_gyp: join(projectDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  }
}

export function writeFakeNodeGyp(projectDir) {
  const toolDir = join(projectDir, 'node_modules', 'node-gyp', 'bin')
  mkdirSync(toolDir, { recursive: true })
  writeFileSync(
    join(toolDir, 'node-gyp.js'),
    `
const { appendFileSync, writeFileSync, writeSync } = require('node:fs')
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`node-gyp \${process.argv.slice(2).join(' ')}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`cwd=\${process.cwd()}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`cxxflags=\${process.env.CXXFLAGS || ''}\\n\`)
appendFileSync(process.env.ORCA_NATIVE_TEST_LOG, \`trackFileAccess=\${process.env.TrackFileAccess ?? ''}\\n\`)
if (process.env.ORCA_NATIVE_TEST_VERBOSE_OUTPUT_BYTES) {
  const output = Buffer.alloc(Number(process.env.ORCA_NATIVE_TEST_VERBOSE_OUTPUT_BYTES), 'x')
  for (let offset = 0; offset < output.length;) {
    offset += writeSync(1, output.subarray(offset))
  }
  writeSync(1, 'node-gyp stdout complete\\n')
  writeSync(2, 'node-gyp stderr complete\\n')
}
writeFileSync(process.env.ORCA_NATIVE_TEST_MARKER, 'rebuilt')
`
  )
}
