import { describe, expect, it } from 'vitest'

import {
  collectWorkspacePathSyncFsCalls,
  collectWorkspacePathSyncFsCounts,
  mentionsWorkspacePath
} from './check-workspace-path-sync-fs-ratchet.mjs'

function callsFor(source) {
  return collectWorkspacePathSyncFsCalls('src/main/example.ts', source)
}

describe('collectWorkspacePathSyncFsCalls', () => {
  it('flags sync probes handed a workspace or repo path', () => {
    const source = [
      'const a = existsSync(worktreePath)',
      'const b = statSync(repo.path)',
      'const c = realpathSync.native(workspacePath)',
      'const d = readFileSync(join(repoPath, "orca.yaml"), "utf-8")',
      'const e = accessSync(cwd)'
    ].join('\n')

    expect(callsFor(source).map((call) => call.call)).toEqual([
      'existsSync',
      'statSync',
      'realpathSync',
      'readFileSync',
      'accessSync'
    ])
  })

  it('flags the camelCase and dotted spellings a workspace path actually arrives in', () => {
    const source = [
      'const a = existsSync(resolvedWorktreePath)',
      'const b = statSync(plan.validationCwd)',
      'const c = realpathSync(effectiveCwd)',
      'const d = statSync(repositoryPath)',
      'const e = readdirSync(worktreesDir)',
      'const f = existsSync(resolveFloatingWorkspacePath(input, home))'
    ].join('\n')

    expect(callsFor(source)).toHaveLength(6)
  })

  it('flags a namespaced probe, since the module object does not move the work off-thread', () => {
    expect(callsFor('const ok = fs.existsSync(workspacePath)')).toHaveLength(1)
  })

  it('reports the line so the failure names a call site', () => {
    const [found] = callsFor('\n\nconst a = existsSync(worktreePath)\n')
    expect(found?.line).toBe(3)
  })

  it('ignores probes on paths that are not a workspace or repo', () => {
    const source = [
      'const a = existsSync(configPath)',
      'const b = statSync(join(tmpdir(), "orca"))',
      'const c = readFileSync(stateFile, "utf-8")',
      '// existsSync(worktreePath) used to live here',
      'const note = "existsSync(repoPath)"'
    ].join('\n')

    expect(callsFor(source)).toEqual([])
  })

  it('ignores record ids and config maps that merely start with a workspace word', () => {
    const source = [
      'const a = existsSync(workspaceId)',
      'const b = statSync(projectMap[key])',
      'const c = accessSync(reposById)'
    ].join('\n')

    expect(callsFor(source)).toEqual([])
  })

  it('ignores the async probes', () => {
    const source = [
      'const a = await stat(worktreePath)',
      'const b = await realpath(workspacePath)',
      'const c = fsPromises.access(cwd)'
    ].join('\n')

    expect(callsFor(source)).toEqual([])
  })

  it('refuses to skip a file it cannot parse', () => {
    expect(() => callsFor('export const = {')).toThrow(/Cannot parse/)
  })
})

describe('mentionsWorkspacePath', () => {
  it.each([
    'repo.path',
    'cwd',
    'worktreePath',
    'plan.validationCwd',
    'resolvedWorktreePath',
    'repositoryPath',
    'worktreesDir',
    'join(repoPath, "orca.yaml")',
    'selectedCheckoutPath'
  ])('accepts %s', (argument) => {
    expect(mentionsWorkspacePath(argument)).toBe(true)
  })

  it.each([
    'configPath',
    'workspaceId',
    'projectMap[key]',
    'stateFile',
    'join(tmpdir(), "orca")',
    'pathA',
    'dotGit',
    'yamlPath'
  ])('ignores %s', (argument) => {
    expect(mentionsWorkspacePath(argument)).toBe(false)
  })
})

describe('collectWorkspacePathSyncFsCounts', () => {
  it('counts per file and drops files with none', () => {
    const counts = collectWorkspacePathSyncFsCounts(
      new Map([
        ['src/main/a.ts', 'existsSync(worktreePath)\nexistsSync(repoPath)\n'],
        ['src/main/b.ts', 'existsSync(configPath)\n']
      ])
    )

    expect([...counts]).toEqual([['src/main/a.ts', 2]])
  })
})
