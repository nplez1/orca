import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import {
  HOME_DIRECTORY_NAME,
  LEGACY_HOME_DIRECTORY_NAME
} from '../../src/shared/app-directory-names'

const HOOK_TREE = fileURLToPath(new URL('../../src/main/agent-hooks/', import.meta.url))
const SOURCE = /\.(?:ts|mts|cts)$/
const NOT_SOURCE = /\.(?:test|spec|test-fixture)\.[cm]?[jt]s$/

/**
 * Resolved by search, not by path: upstream relocated these out of `installer-utils.ts` into
 * `installation/` and will again, so a hardcoded import would fail on the move instead of on the
 * behaviour. A re-export does not count — the definition is what the fork has to own.
 */
function definingModules(exportName) {
  const definition = new RegExp(`^export (?:async )?(?:function|const) ${exportName}\\b`, 'm')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name)) {
        if (definition.test(readFileSync(path, 'utf8'))) {
          found.push(path)
        }
      }
    }
  }
  walk(HOOK_TREE)
  return found
}

async function moduleExporting(exportName) {
  const defining = definingModules(exportName)
  expect(
    defining.map((path) => relative(HOOK_TREE, path)),
    `expected exactly one module under src/main/agent-hooks to define ${exportName}`
  ).toHaveLength(1)
  return import(pathToFileURL(defining[0]).href)
}

it('writes the shared managed-hook script under this build home, not the official ~/.orca', async () => {
  const { getSharedManagedScriptPath } = await moduleExporting('getSharedManagedScriptPath')
  const scriptFileName = 'claude-hook.sh'
  const resolved = getSharedManagedScriptPath(scriptFileName)

  expect(resolved).toBe(join(homedir(), HOME_DIRECTORY_NAME, 'agent-hooks', scriptFileName))
  // Why: the assertion above follows HOME_DIRECTORY_NAME, so a revert of that constant would satisfy
  // it. The legacy name is the official install's home, and must never be the one this build writes.
  expect(resolved.split(/[\\/]+/)).not.toContain(LEGACY_HOME_DIRECTORY_NAME)
})

it('runs the managed hook from this build home, not the official ~/.orca', async () => {
  const { wrapRuntimeHomeHookCommand } = await moduleExporting('wrapRuntimeHomeHookCommand')
  const command = wrapRuntimeHomeHookCommand('claude-hook')
  // The PowerShell branch travels base64/UTF-16, so it is decoded rather than pattern-matched.
  const encoded = command.match(/-EncodedCommand (\S+)/)?.[1]
  expect(encoded, 'expected the PowerShell branch to be encoded in the command').toBeTruthy()

  for (const [branch, separator] of [
    [command, '/'],
    [Buffer.from(encoded, 'base64').toString('utf16le'), '\\']
  ]) {
    expect(branch).toContain(`${HOME_DIRECTORY_NAME}${separator}agent-hooks${separator}`)
    expect(branch).not.toContain(`${LEGACY_HOME_DIRECTORY_NAME}${separator}agent-hooks${separator}`)
  }
})
