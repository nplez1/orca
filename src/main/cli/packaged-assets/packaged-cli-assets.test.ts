import { execFile } from 'node:child_process'

import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const itRunsUnixShell = process.platform === 'win32' ? it.skip : it

const linuxLauncherAsset = new URL('../../../../resources/linux/bin/orca-ide', import.meta.url)
const darwinLauncherAsset = new URL('../../../../resources/darwin/bin/orca', import.meta.url)
const unixLauncherFixtures = [
  {
    name: 'Linux',
    asset: linuxLauncherAsset,
    appDir: ['Orca'],
    launcher: ['resources', 'bin', 'orca-ide'],
    executable: ['orca-ide'],
    cli: ['resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
  },
  {
    name: 'macOS',
    asset: darwinLauncherAsset,
    // This fork's bundle is Orca NP (productName in electron-builder.np.config.cjs).
    appDir: ['Orca NP.app'],
    launcher: ['Contents', 'Resources', 'bin', 'orca'],
    executable: ['Contents', 'MacOS', 'Orca NP'],
    cli: ['Contents', 'Resources', 'app.asar.unpacked', 'out', 'cli', 'index.js']
  }
] as const

describe('packaged CLI assets', () => {
  itRunsUnixShell.each(unixLauncherFixtures)(
    'sanitizes node env and forwards argv verbatim through the $name launcher',
    async (launcherFixture) => {
      // Why realpath: the launcher resolves its own location physically, so /tmp vs /private/tmp differs.
      const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-unix-cli-env-')))
      try {
        const appDir = join(root, ...launcherFixture.appDir)
        const launcherPath = join(appDir, ...launcherFixture.launcher)
        const electronPath = join(appDir, ...launcherFixture.executable)
        const cliPath = join(appDir, ...launcherFixture.cli)

        await mkdir(dirname(launcherPath), { recursive: true })
        await mkdir(dirname(electronPath), { recursive: true })
        await mkdir(dirname(cliPath), { recursive: true })
        await copyFile(launcherFixture.asset, launcherPath)
        await writeFile(cliPath, '', 'utf8')
        await writeFile(
          electronPath,
          `#!/usr/bin/env bash
node -e 'console.log(JSON.stringify({
  argv: process.argv.slice(1),
  runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  orcaNodeOptions: process.env.ORCA_NODE_OPTIONS ?? null,
  nodeReplExternalModule: process.env.NODE_REPL_EXTERNAL_MODULE ?? null,
  orcaNodeReplExternalModule: process.env.ORCA_NODE_REPL_EXTERNAL_MODULE ?? null
}))' -- "$@"
`,
          { encoding: 'utf8', mode: 0o755 }
        )

        const result = await execFileAsync(launcherPath, ['--help', 'two words'], {
          // A session's own CLI hands off first (its own suite covers that hop); this asserts argv.
          env: launcherChildEnv()
        })
        const payload = JSON.parse(result.stdout) as {
          argv: string[]
          runAsNode: string
          nodeOptions: string | null
          orcaNodeOptions: string | null
          nodeReplExternalModule: string | null
          orcaNodeReplExternalModule: string | null
        }

        expect(payload.argv).toEqual([cliPath, '--help', 'two words'])
        expect(payload.runAsNode).toBe('1')
        // Hide node options from Electron's bootstrap but preserve them for the CLI.
        expect(payload.nodeOptions).toBeNull()
        expect(payload.orcaNodeOptions).toBe('--trace-warnings')
        expect(payload.nodeReplExternalModule).toBeNull()
        expect(payload.orcaNodeReplExternalModule).toBe('external-loader')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

function launcherChildEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== 'ORCA_CLI_COMMAND' && key !== 'ORCA_CLI_HANDOFF'
    )
  )
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '0',
    NODE_OPTIONS: '--trace-warnings',
    NODE_REPL_EXTERNAL_MODULE: 'external-loader'
  }
}
