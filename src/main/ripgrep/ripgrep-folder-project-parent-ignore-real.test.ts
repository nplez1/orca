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

describe.skipIf(process.platform === 'win32')('real ripgrep and an enclosing checkout', () => {
  it('lists a folder project inside a git checkout by its own files, not the parent ignore rules', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-rg-folder-project-'))
    const checkout = join(parent, 'checkout')
    const folderProject = join(checkout, 'notes')
    try {
      await mkdir(folderProject, { recursive: true })
      await writeFile(join(checkout, '.gitignore'), 'dist/\n*.log\n')
      git(checkout, 'init', '-q')
      await writeFile(join(folderProject, 'notes.md'), '# notes')
      await writeFile(join(folderProject, 'debug.log'), 'kept')

      const checkoutRules = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      // The parent's patterns are what makes the bug visible: they name this workspace's files.
      expect(await capture(folderProject, checkoutRules.primary)).toEqual(['notes.md'])

      const folderProjectRules = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false,
        isFolderProject: true
      })
      expect(await capture(folderProject, folderProjectRules.primary)).toEqual([
        'debug.log',
        'notes.md'
      ])
      expect(await capture(folderProject, folderProjectRules.ignoredPass)).toEqual([
        'debug.log',
        'notes.md'
      ])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
