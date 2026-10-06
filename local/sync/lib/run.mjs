// Shared plumbing for local/sync/pre-sync.mjs and local/sync/post-sync.mjs.
//
// Why one module: both tools must agree on where the pre-sync state file lives and on what
// "passed", "skipped" and "unavailable" mean. A check that could not be run must never read
// as a check that passed, so the vocabulary is defined once, here.
//
// Nothing here mutates the repository except writeSyncState(), which --prepare calls.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const STATUS = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  unavailable: 'unavailable',
  info: 'info'
}

const LABEL = {
  passed: 'PASS',
  failed: 'FAIL',
  skipped: 'SKIP',
  unavailable: 'N/A',
  info: 'INFO'
}

// local/sync — where the sibling tools live. Resolved from this file, not the cwd, so the
// tools work when invoked by absolute path from anywhere inside the repository.
export const TOOLS_DIR = path.dirname(import.meta.dirname)

// The state file the sync needs to survive between the two tools. `.gitignore` in this fork is
// upstream-owned (no local() commit has ever touched it), so the state lives under the git
// directory rather than a path we would have to make ignorable.
const STATE_FILE_NAME = 'orca-pre-sync-state.json'
// Read-only fallback for a state file written by hand or by an earlier revision of this tool.
const HAND_WRITTEN_STATE = path.join(TOOLS_DIR, 'state.json')

// pnpm is a shell script on POSIX and a .cmd shim on Windows; execFileSync resolves neither
// PATHEXT nor a shell, so the name has to be spelled per platform.
export function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function describe(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

// Returns { ok, code, stdout, stderr, command } and never throws: every caller here wants the
// failure as data, because a failing command is usually a failing check, not a crash.
export function run(command, args, options = {}) {
  const spawn = {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024
  }
  if (options.timeoutMs) {
    spawn.timeout = options.timeoutMs
  }
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync(command, args, spawn),
      stderr: '',
      command: describe(command, args)
    }
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    return {
      ok: false,
      // null code = the command never ran (ENOENT); a number = it ran and failed.
      code: typeof error.status === 'number' ? error.status : null,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: stderr || error.message || String(error),
      command: describe(command, args)
    }
  }
}

let cachedRoot = null

export function repoRoot() {
  if (cachedRoot) {
    return cachedRoot
  }
  const result = run('git', ['rev-parse', '--show-toplevel'])
  cachedRoot = result.ok ? result.stdout.trim() : process.cwd()
  return cachedRoot
}

export function git(args, options = {}) {
  return run('git', args, { cwd: options.cwd ?? repoRoot(), timeoutMs: options.timeoutMs })
}

// Trimmed stdout, or null when the command failed — the shape most ref lookups want.
export function gitText(args, options = {}) {
  const result = git(args, options)
  return result.ok ? result.stdout.trim() : null
}

export function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', ref]).ok
}

export function splitNul(text) {
  return text.split('\0').filter((entry) => entry.length > 0)
}

export function changedNames(args) {
  const result = git(['diff', '--name-only', '-z', ...args])
  return result.ok ? splitNul(result.stdout) : null
}

export function tailText(text, maxLines = 25) {
  const lines = text.trimEnd().split('\n')
  return lines.length <= maxLines ? lines : ['...', ...lines.slice(-maxLines)]
}

// For output whose finding is at the top (a structured report of violations), not at the bottom.
export function headText(text, maxLines = 25) {
  const lines = text.trimEnd().split('\n')
  return lines.length <= maxLines
    ? lines
    : [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more line(s)`]
}

export function toolPath(name) {
  return path.join(TOOLS_DIR, name)
}

export function toolExists(name) {
  return existsSync(toolPath(name))
}

// git merge-tree --write-tree --name-only prints the tree OID, then the conflicted paths, then
// an informational section ("Auto-merging ...", "CONFLICT (...): ...", or nothing). Only the
// middle section is a path list, and a non-zero exit with no parsed path means the output was
// not understood rather than that there is no conflict.
export function mergeTree(a, b) {
  const result = git(['merge-tree', '--write-tree', '--name-only', a, b])
  const lines = result.stdout.split('\n')
  const files = []
  for (const line of lines.slice(1)) {
    if (line === '' || /^(Auto-merging |CONFLICT |error:|fatal:)/.test(line)) {
      break
    }
    files.push(line)
  }
  return { ...result, tree: lines[0]?.trim() ?? null, files }
}

let cachedGitDir = null

export function gitDir() {
  if (cachedGitDir) {
    return cachedGitDir
  }
  const raw = gitText(['rev-parse', '--absolute-git-dir']) ?? gitText(['rev-parse', '--git-dir'])
  cachedGitDir = raw ? path.resolve(repoRoot(), raw) : repoRoot()
  return cachedGitDir
}

export function stateFilePath() {
  return path.join(gitDir(), STATE_FILE_NAME)
}

export function readSyncState() {
  for (const [source, file] of [
    ['git-dir state file', stateFilePath()],
    ['local/sync/state.json', HAND_WRITTEN_STATE]
  ]) {
    try {
      return { state: JSON.parse(readFileSync(file, 'utf8')), source, file }
    } catch {
      // Missing or unreadable: fall through to the next source.
    }
  }
  return { state: null, source: null, file: null }
}

export function writeSyncState(state) {
  const file = stateFilePath()
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
  return file
}

export class Report {
  constructor(title, meta = {}) {
    this.title = title
    this.meta = meta
    this.checks = []
  }

  // Positional rather than an options object: both tools add eight checks, and the field names
  // were drowning the summaries that carry the actual finding.
  add(id, status, title, summary = '', extra = {}) {
    const entry = { id, status, title, summary, details: [], ...extra }
    this.checks.push(entry)
    return entry
  }

  // Register the outcome of one gate (see lib/checks.mjs). `look` is what the operator has to
  // inspect when the gate fails, so it is required for every check that can fail.
  addOutcome(id, title, look, outcome) {
    return this.add(id, outcome.status, title, outcome.summary, {
      look,
      details: outcome.details ?? []
    })
  }

  get failures() {
    return this.checks.filter((check) => check.status === STATUS.failed)
  }

  get notRun() {
    return this.checks.filter(
      (check) => check.status === STATUS.skipped || check.status === STATUS.unavailable
    )
  }

  result() {
    return this.failures.length === 0 ? 'pass' : 'fail'
  }

  render(summary) {
    const lines = [`== ${this.title} ==`]
    for (const [key, value] of Object.entries(this.meta)) {
      lines.push(`${key}: ${value}`)
    }
    lines.push('')
    for (const check of this.checks) {
      lines.push(
        `[${LABEL[check.status]}] ${check.title}${check.summary ? ` — ${check.summary}` : ''}`
      )
      for (const detail of check.details) {
        lines.push(`       ${detail}`)
      }
    }
    lines.push('-'.repeat(72))
    const counts = Object.keys(STATUS)
      .map((status) => [status, this.checks.filter((check) => check.status === status).length])
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${count} ${status}`)
      .join(', ')
    lines.push(`${this.checks.length} check(s): ${counts}`)
    if (this.notRun.length > 0) {
      lines.push(
        `NOT RUN: ${this.notRun
          .map((check) => `${check.title} (${check.status})`)
          .join('; ')} — these are not passes, confirm them another way`
      )
    }
    const verdict =
      this.failures.length === 0
        ? `result: PASS — no hard gate failed`
        : `result: FAIL — ${this.failures.length} of ${this.checks.length} check(s) failed`
    lines.push(verdict)
    for (const failure of this.failures) {
      lines.push(`  fix: ${failure.look}`)
    }
    if (summary) {
      lines.push(...summary)
    }
    return lines.join('\n')
  }

  toJSON(extra = {}) {
    return {
      tool: this.title,
      generatedAt: new Date().toISOString(),
      meta: this.meta,
      result: this.result(),
      checks: this.checks,
      notRun: this.notRun.map((check) => ({ id: check.id, status: check.status })),
      ...extra
    }
  }
}
