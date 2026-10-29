import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

/**
 * `local/orca-vm/extend.sh` runs after the provider has already granted (and billed) the extension, so
 * a follow-up read that fails must not silently exit 1: the app would keep the old deadline and reclaim
 * a lease the user just paid for.
 */

const SCRIPT = new URL('../../local/orca-vm/extend.sh', import.meta.url).pathname
const PAYLOAD = JSON.stringify({
  recipeResult: {
    schemaVersion: 1,
    connection: { type: 'orc', projectRoot: '/workspace/repo' },
    userData: { resourceId: 'res-1', releaseAt: '2026-06-01T12:00:00Z' }
  },
  lifetime: '4h'
})
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * `extend` answers with whatever the case needs; `show` fails until `showSucceedsAfter` reads have
 * happened, which models a provider CLI that is briefly unavailable after the grant.
 */
function makeBin({ extendOutput, showOutput = '', showSucceedsAfter = Number.MAX_SAFE_INTEGER }) {
  const binDir = makeDir('orca-vm-extend-bin-')
  const showCount = join(binDir, 'show.count')
  writeFileSync(showCount, '0')
  writeFileSync(
    join(binDir, 'team-machines'),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      'const [verb, ...rest] = process.argv.slice(2)',
      "if (verb === 'extend') {",
      `  process.stdout.write(${JSON.stringify(extendOutput)})`,
      "} else if (verb === 'show') {",
      `  const countPath = ${JSON.stringify(showCount)}`,
      "  const count = Number(fs.readFileSync(countPath, 'utf8')) + 1",
      '  fs.writeFileSync(countPath, String(count))',
      `  if (count <= ${showSucceedsAfter}) {`,
      "    process.stderr.write('show: provider CLI unavailable\\n')",
      '    process.exit(1)',
      '  }',
      `  process.stdout.write(${JSON.stringify(showOutput)})`,
      '}',
      ''
    ].join('\n')
  )
  chmodSync(join(binDir, 'team-machines'), 0o755)
  return { binDir, showReads: () => Number(readFileSync(showCount, 'utf8')) }
}

function runExtend(binDir) {
  return new Promise((resolve) => {
    const child = spawn('sh', [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(`${PAYLOAD}\n`)
  })
}

it('reports the deadline the extend grant itself returned when the follow-up read fails', async () => {
  // Why this case exists: `set -e` on the failed `show` exited 1 with no message at all, after the
  // provider had already granted the extension — the app kept the old deadline.
  const { binDir, showReads } = makeBin({
    extendOutput: JSON.stringify({
      expiresAt: '2026-06-01T16:00:00Z',
      remainingSeconds: 14400
    })
  })

  const { code, stdout, stderr } = await runExtend(binDir)

  expect(code).toBe(0)
  // No read at all: the grant already answered, so the step that can fail is never taken.
  expect(showReads()).toBe(0)
  expect(stderr).toContain('2026-06-01T16:00:00Z')
  expect(JSON.parse(stdout)).toMatchObject({
    userData: { resourceId: 'res-1', releaseAt: '2026-06-01T16:00:00Z', lifetimeSeconds: 14400 }
  })
})

it('retries the follow-up read instead of throwing away the grant', async () => {
  const { binDir, showReads } = makeBin({
    extendOutput: 'extended',
    showOutput: JSON.stringify({ expiresAt: '2026-06-01T17:00:00Z', remainingSeconds: 18000 }),
    showSucceedsAfter: 2
  })

  const { code, stdout } = await runExtend(binDir)

  expect(code).toBe(0)
  expect(showReads()).toBe(3)
  expect(JSON.parse(stdout)).toMatchObject({
    userData: { releaseAt: '2026-06-01T17:00:00Z', lifetimeSeconds: 18000 }
  })
})

it('says why it failed, and names the resource, when no read reports a deadline', async () => {
  const { binDir, showReads } = makeBin({ extendOutput: JSON.stringify({ ok: true }) })

  const { code, stdout, stderr } = await runExtend(binDir)

  expect(code).toBe(1)
  expect(stdout).toBe('')
  expect(showReads()).toBe(3)
  expect(stderr).toContain('res-1')
  expect(stderr).toContain('reclaimed early')
})
