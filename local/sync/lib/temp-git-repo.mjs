// A throwaway git repository for the sync tools' temp-repo tests. Hooks and signing are off so a
// developer's global config cannot change what a fixture commit contains.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

export function tempGitRepo(prefix) {
  // A hook's GIT_DIR or GIT_INDEX_FILE would aim every fixture commit, and the tool under test, at the real repo.
  for (const key of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) {
    delete process.env[key]
  }
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  const write = (files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), text)
    }
  }
  const commit = (message, files = {}) => {
    write(files)
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', path.join(dir, '.no-hooks'))
  return { dir, git, write, commit, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
