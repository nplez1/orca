import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')

function section(text, heading) {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  expect(start, `missing heading: ${heading}`).toBeGreaterThan(-1)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

const entries = (lines) => lines.filter((line) => /^- \*\*\d{4}-\d{2}-\d{2}/.test(line))

/** Why the fenced blocks only: prose is allowed to mention a mistake the commands must not repeat. */
function codeBlocks(text) {
  const blocks = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (current) {
        blocks.push(current.join('\n'))
        current = null
      } else {
        current = []
      }
    } else if (current) {
      current.push(line)
    }
  }
  return blocks
}

it('keeps the sync log readable by policy, not by good intentions', () => {
  const patches = read('LOCAL-PATCHES.md')
  const syncLog = section(patches, '### Sync log')

  expect(syncLog.join('\n')).toContain('local/sync/sync-log-archive.md')
  expect(entries(syncLog).length).toBeLessThanOrEqual(3)
  expect(entries(syncLog).length).toBeGreaterThan(0)

  const archive = new URL('local/sync/sync-log-archive.md', ROOT)
  expect(existsSync(archive)).toBe(true)
  expect(entries(readFileSync(archive, 'utf8').split('\n')).length).toBeGreaterThan(
    entries(syncLog).length
  )
})

it('documents the release-line sync as a merge, which is what the runbook runs', () => {
  const patches = read('LOCAL-PATCHES.md')
  const syncing = section(patches, '## Syncing with upstream').join('\n')

  expect(syncing).toContain('git merge upstream/main')
  expect(syncing).not.toContain('git rebase origin/main')
  expect(read('UPSTREAM-SYNC-RUNBOOK.md')).toContain('git merge upstream/main')
})

it('derives every shared /tmp path instead of naming a fixed one', () => {
  const fixedRedirect = />{1,2}\s*\/tmp\/[A-Za-z0-9_.-]+/
  const fixedName = /\/tmp\/(modified\.txt|upstream-changed\.txt|body\.md)/

  for (const file of ['LOCAL-PATCHES.md', 'BRANCHES.md', 'UPSTREAM-SYNC-RUNBOOK.md', 'AGENTS.md']) {
    for (const block of codeBlocks(read(file))) {
      expect(block, file).not.toMatch(fixedRedirect)
      expect(block, file).not.toMatch(fixedName)
    }
  }
  expect(codeBlocks(read('LOCAL-PATCHES.md')).join('\n')).toContain('mktemp')
  expect(read('local/open-pr.mjs')).not.toContain('/tmp/body.md')
})

it('states the fork PR base the hook and the script both enforce', () => {
  const hook = read('.husky/commit-msg')

  expect(hook).toContain('nplez1/main')
  expect(hook).not.toContain('PR branches are cut from origin/main')
})

it('records what the runners actually bill, instead of the billed-minutes premise', () => {
  const live = section(
    read('LOCAL-PATCHES.md'),
    '### `local(ci)`: which workflows are live on this fork'
  ).join('\n')

  // Standard runners bill nothing on a public repository, so a minutes budget is not a reason to
  // disable a lane — and it was the recorded reason for disabling `pr.yml` (issue #221 C2).
  expect(live).not.toMatch(/billed minutes/i)
  expect(live).not.toContain('1,500 min/month')
  expect(live).toContain('actions/runs')
  expect(live).toContain('billable')
})

it('names the cheap PR lane it decided on, and why the unit suite is not it', () => {
  const live = section(
    read('LOCAL-PATCHES.md'),
    '### `local(ci)`: which workflows are live on this fork'
  ).join('\n')
  const workflow = read('.github/workflows/fork-pr-gates.yml')

  expect(live).toContain('fork-pr-gates.yml')
  expect(live).toContain('cheapest useful lane')
  expect(workflow).toContain('pull_request')
  expect(read('local/check-actions-enablement.mjs')).toContain(
    "'.github/workflows/fork-pr-gates.yml'"
  )
})

it('pushes the upstream mirror through the enablement sweep, not as a bare git push', () => {
  // A workflow file new to that push arrives active; sweeping afterwards in the same step is the only
  // lever, because there is no workflow to disable until the file exists (issue #221 C5).
  const step = section(read('UPSTREAM-SYNC-RUNBOOK.md'), '## Step 4 — push').join('\n')
  const blocks = codeBlocks(step).join('\n')

  expect(blocks).toContain('node local/sync/push-upstream-mirror.mjs')
  expect(blocks).not.toMatch(/^git push origin upstream\/main:main/m)
  expect(blocks).toContain('node local/check-actions-enablement.mjs')
})
