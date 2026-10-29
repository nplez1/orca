import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'
import { buildRgArgsForQuickOpen, normalizeQuickOpenRgLine } from '../../shared/quick-open-filter'

async function capture(root: string, args: string[]): Promise<string[]> {
  const child = spawnBundledRipgrep(args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr?.resume()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`rg exit ${code}`))))
  })
  return output
    .split('\0')
    .filter(Boolean)
    .map((line) => normalizeQuickOpenRgLine(line, { kind: 'cwd-relative' }))
    .filter((name): name is string => name !== null)
    .sort()
}

function git(cwd: string, ...args: string[]): void {
  const result = runProcessSync({ program: 'git', args, cwd })
  expect(result.code, result.stderr).toBe(0)
}

/**
 * A folder project inside a git checkout, with the parent naming files in the workspace both ways an
 * enclosing checkout can: `.gitignore` (VCS rules, which the broad pass already ignores) and `.ignore`
 * (which it does not). The workspace's own root rules must survive either way.
 */
async function makeCheckoutWithFolderProject(): Promise<{
  parent: string
  checkout: string
  folder: string
}> {
  const parent = await mkdtemp(join(tmpdir(), 'orca-rg-folder-project-'))
  const checkout = join(parent, 'checkout')
  const folder = join(checkout, 'notes')
  await mkdir(join(folder, 'dist'), { recursive: true })
  await mkdir(join(folder, 'pkg', 'out'), { recursive: true })
  await writeFile(join(checkout, '.gitignore'), 'dist/\n*.log\n')
  await writeFile(join(checkout, '.ignore'), '*.log\n')
  await writeFile(join(folder, '.ignore'), 'out/\n')
  await writeFile(join(folder, 'notes.md'), '# notes')
  await writeFile(join(folder, 'debug.log'), 'parent-named')
  await writeFile(join(folder, 'dist', 'bundle.js'), 'parent-named dir')
  await writeFile(join(folder, 'pkg', 'keep.md'), '# pkg')
  await writeFile(join(folder, 'pkg', 'debug.log'), 'parent-named')
  await writeFile(join(folder, 'pkg', 'out', 'scratch.js'), 'workspace-named dir')
  git(checkout, 'init', '-q')
  return { parent, checkout, folder }
}

describe.skipIf(process.platform === 'win32')('real ripgrep and an enclosing checkout', () => {
  it('lists a folder project by its own files, not the parent checkout ignore rules', async () => {
    const { parent, folder } = await makeCheckoutWithFolderProject()
    try {
      const checkoutRules = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      // The bug: the parent's patterns name this workspace's files, and the narrow pass obeys them.
      expect(await capture(folder, checkoutRules.primary)).toEqual([
        '.ignore',
        'notes.md',
        'pkg/keep.md'
      ])
      // The broad pass ignores VCS rules but not `.ignore`, so the parent's `*.log` still applied.
      expect(await capture(folder, checkoutRules.ignoredPass)).toEqual([
        '.ignore',
        'dist/bundle.js',
        'notes.md',
        'pkg/keep.md'
      ])

      const folderProjectRules = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false,
        isFolderProject: true
      })
      const expected = [
        '.ignore',
        'debug.log',
        'dist/bundle.js',
        'notes.md',
        'pkg/debug.log',
        'pkg/keep.md'
      ]
      expect(await capture(folder, folderProjectRules.primary)).toEqual(expected)
      expect(await capture(folder, folderProjectRules.ignoredPass)).toEqual(expected)
      // The workspace's own `.ignore` still applies: `out/` stays pruned either way.
      expect(await capture(folder, folderProjectRules.primary)).not.toContain('pkg/out/scratch.js')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('keeps the workspace root ignore files when a watcher rescans a subfolder', async () => {
    const { parent, folder } = await makeCheckoutWithFolderProject()
    try {
      // The index reconciliation scans a subtree, so the workspace root sits above the search root —
      // and `--no-ignore-parent` there would drop the workspace's own rules, not just the checkout's.
      const subtreeScan = buildRgArgsForQuickOpen({
        searchRoot: 'pkg',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      expect(await capture(folder, subtreeScan.primary)).toEqual(['pkg/keep.md'])

      const withParentIgnoresDropped = buildRgArgsForQuickOpen({
        searchRoot: 'pkg',
        excludePathPrefixes: [],
        forceSlashSeparator: false,
        isFolderProject: true
      })
      expect(await capture(folder, withParentIgnoresDropped.primary)).toEqual([
        'pkg/debug.log',
        'pkg/keep.md',
        'pkg/out/scratch.js'
      ])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
