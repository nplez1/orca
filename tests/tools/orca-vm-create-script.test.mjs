import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

/**
 * `local/orca-vm/create.sh` allocates a machine the user pays for, so two of its outcomes are
 * contractual: a cancelled create must release the machine, and its single stdout object must always
 * be parseable JSON. Both are exercised against a stub provisioner, because the real one bills.
 */

const SCRIPT = new URL('../../local/orca-vm/create.sh', import.meta.url).pathname
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

function writeStub(binDir, name, source) {
  const path = join(binDir, name)
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

/**
 * The whole provider surface the script may touch, plus an `ssh` that answers however the case needs:
 * a real ssh would depend on a host, and the cancel case deliberately never reaches one.
 *
 * `ssh` also records that it was called, which is the only point at which the script's signal trap is
 * guaranteed to be armed — a wait on the provisioner's marker would race the arming itself.
 */
function makeBin({ created, sshExitCode }) {
  const binDir = makeDir('orca-vm-create-bin-')
  const sshMarker = join(binDir, 'ssh-ran')
  writeStub(
    binDir,
    'team-machines',
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      'const [verb, ...rest] = process.argv.slice(2)',
      "if (verb === 'create') {",
      `  fs.writeFileSync(${JSON.stringify(join(binDir, 'create.json'))}, JSON.stringify(rest))`,
      `  process.stdout.write(${JSON.stringify(JSON.stringify(created))})`,
      "} else if (verb === 'destroy') {",
      `  fs.appendFileSync(${JSON.stringify(join(binDir, 'destroy.log'))}, rest[0] + '\\n')`,
      '}',
      ''
    ].join('\n')
  )
  writeStub(
    binDir,
    'ssh',
    ['#!/bin/sh', `: > ${JSON.stringify(sshMarker)}`, `exit ${sshExitCode}`, ''].join('\n')
  )
  return { binDir, destroyLog: join(binDir, 'destroy.log'), sshMarker }
}

function scriptEnv(binDir, overrides = {}) {
  return {
    ...process.env,
    PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH}`,
    ORCA_WORKSPACE_NAME: 'fix-login-race',
    ORCA_REPO_URL: 'https://example.com/orca.git',
    SSH_USER: 'developer',
    ...overrides
  }
}

function runCreate(binDir, overrides = {}) {
  const child = spawn('sh', [SCRIPT], { env: scriptEnv(binDir, overrides) })
  const chunks = []
  child.stderr.on('data', (chunk) => chunks.push(chunk))
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  return { child, closed, stderr: () => chunks.join(''), stdout: () => stdout }
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (existsSync(path)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${path}`)
}

it('releases the machine when the create is cancelled mid-flight', async () => {
  // Why this case exists: Orca cancels by killing the recipe's process group, so a script that cleans
  // up only on explicit `exit` paths skips every release exactly when the machine is likeliest to leak.
  const { binDir, destroyLog, sshMarker } = makeBin({
    created: { id: 'res-cancelled', address: 'host.example.com' },
    sshExitCode: 1
  })
  const create = runCreate(binDir)

  // Why the ssh marker: the trap is armed just before the first ssh call, so waiting for it is the
  // first moment a SIGTERM is guaranteed to reach the handler rather than kill the shell outright.
  await waitForPath(sshMarker)
  create.child.kill('SIGTERM')

  // The trap runs once the foreground `sleep` of the SSH retry loop returns, so this settles in ~2s.
  await expect(create.closed).resolves.toBe(130)
  expect(readFileSync(destroyLog, 'utf8').trim()).toBe('res-cancelled')
  expect(create.stderr()).toContain('cancelled')
})

it('quotes a host and workspace name that would otherwise produce unparseable JSON', async () => {
  // Why this case exists: the result used to be built with printf, so a quote in the provider address
  // exited 0 with invalid JSON — Orca got no recipeResult, never recorded the machine, and treated the
  // create as successful.
  const host = 'host"with\\quote.example.com'
  const { binDir, destroyLog } = makeBin({
    created: { id: 'res-1', address: host },
    sshExitCode: 0
  })

  const create = runCreate(binDir, { ORCA_WORKSPACE_NAME: 'name"with\\quote' })

  expect(await create.closed).toBe(0)
  expect(existsSync(destroyLog)).toBe(false)
  // Exactly one line: the recipe contract is one JSON object and nothing else on stdout.
  expect(create.stdout().trim().split('\n')).toHaveLength(1)
  expect(JSON.parse(create.stdout())).toEqual({
    schemaVersion: 1,
    connection: {
      type: 'ssh',
      projectRoot: '/home/developer/orca',
      target: {
        label: 'orca-name"with\\quote',
        host,
        port: 22,
        username: 'developer',
        relayGracePeriodSeconds: 3600
      }
    },
    userData: { resourceId: 'res-1' }
  })
})
