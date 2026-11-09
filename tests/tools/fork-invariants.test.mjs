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
const DEFINES_RESOLVER = /^export function getSharedManagedScriptPath\b/m
const NOT_SOURCE = /\.test\.[cm]?[jt]s$|\.test-fixture\.[cm]?[jt]s$/

/**
 * Resolved by search, not by path: upstream relocated this function out of `installer-utils.ts` and
 * will again, so a hardcoded import would fail on the move instead of on the behaviour.
 */
function resolverModules() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.name.endsWith('.ts') && !NOT_SOURCE.test(entry.name)) {
        if (DEFINES_RESOLVER.test(readFileSync(path, 'utf8'))) {
          found.push(path)
        }
      }
    }
  }
  walk(HOOK_TREE)
  return found
}

async function sharedManagedScriptPath(scriptFileName) {
  const defining = resolverModules()
  expect(
    defining.map((path) => relative(HOOK_TREE, path)),
    'expected exactly one module under src/main/agent-hooks to define getSharedManagedScriptPath'
  ).toHaveLength(1)
  const { getSharedManagedScriptPath } = await import(pathToFileURL(defining[0]).href)
  return getSharedManagedScriptPath(scriptFileName)
}

it('resolves the shared managed-hook script under this build home, not the official ~/.orca', async () => {
  const scriptFileName = 'claude-hook.sh'
  const resolved = await sharedManagedScriptPath(scriptFileName)

  expect(resolved).toBe(join(homedir(), HOME_DIRECTORY_NAME, 'agent-hooks', scriptFileName))
  // Why: the assertion above follows HOME_DIRECTORY_NAME, so a revert of that constant would satisfy
  // it. The legacy name is the official install's home, and must never be the one this build writes.
  expect(resolved.split(/[\\/]+/)).not.toContain(LEGACY_HOME_DIRECTORY_NAME)
})
