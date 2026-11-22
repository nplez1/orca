import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  botGhMarker,
  botGhMarkerOf,
  botGhShimEnv,
  botGhShimScript,
  withBotGhShimOnPath
} from './fork-gh-shim'

const POSIX = process.platform !== 'win32'

// A fake gh that records its own argv, one per line, so a passthrough is compared byte for byte.
const FAKE_GH = ['#!/bin/sh', 'printf "%s\\n" "$#" "$@"', 'exit ${FAKE_GH_STATUS:-0}', ''].join(
  '\n'
)

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function rig(): Promise<{ shim: string; shimDir: string; realDir: string; body: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-gh-shim-'))
  dirs.push(root)
  const shimDir = join(root, 'shim')
  const realDir = join(root, 'real')
  const body = join(root, 'body.md')
  await chmod(root, 0o755)
  await Promise.all([mkdir(shimDir), mkdir(realDir)])
  const shim = join(shimDir, 'gh')
  await writeFile(shim, botGhShimScript(botGhMarker('Scout')), { mode: 0o755 })
  await writeFile(join(realDir, 'gh'), FAKE_GH, { mode: 0o755 })
  await writeFile(body, 'Reviewed the diff.')
  return { shim, shimDir, realDir, body }
}

/** The shim as a bot's shell runs it: its own argv, PATH, and whatever the call pipes in. */
function gh(
  rigged: { shim: string; shimDir: string; realDir: string },
  args: string[],
  env: Record<string, string> = {},
  input?: string
): Promise<{ lines: string[]; code: number }> {
  const path = [rigged.shimDir, rigged.realDir, '/usr/bin', '/bin'].join(':')
  return new Promise((resolve, reject) => {
    const child = spawn(rigged.shim, args, { env: { ...process.env, PATH: path, ...env } })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({ lines: stdout.split('\n').slice(0, -1), code: code ?? 1 })
    )
    child.stdin.end(input)
  })
}

const argsOf = (lines: string[]) => lines.slice(1)
/** The body gh was handed: every argument after the last `--body`. */
const bodyOf = (lines: string[]) => {
  const args = argsOf(lines)
  const at = args.lastIndexOf('--body')
  return at === -1 ? '' : args.slice(at + 1).join('\n')
}

describe.skipIf(!POSIX)('the bot gh shim', () => {
  it('marks a comment body given inline', async () => {
    const rigged = await rig()

    const { lines } = await gh(rigged, ['pr', 'comment', '7', '-b', 'Looks good.'])

    expect(argsOf(lines).slice(0, 3)).toEqual(['pr', 'comment', '7'])
    expect(bodyOf(lines)).toContain('Looks good.')
    expect(bodyOf(lines)).toContain('<!-- orca-bot:Scout -->')
  })

  it('marks a review body, and the long --body spelling', async () => {
    const rigged = await rig()

    const { lines } = await gh(rigged, ['pr', 'review', '7', '--body=Please fix the typo.'])

    expect(bodyOf(lines)).toContain('Please fix the typo.')
    expect(bodyOf(lines)).toContain('<!-- orca-bot:Scout -->')
  })

  it('reads --body-file and hands gh the marked body as an argument, leaving the file alone', async () => {
    const rigged = await rig()

    const { lines } = await gh(rigged, ['issue', 'comment', '12', '--body-file', rigged.body])

    expect(argsOf(lines).slice(0, 4)).toEqual(['issue', 'comment', '12', '--body'])
    expect(bodyOf(lines)).toBe('Reviewed the diff.\n\n<!-- orca-bot:Scout -->')
    expect(await readFile(rigged.body, 'utf8')).toBe('Reviewed the diff.')
  })

  it('reads a body piped in with -F -, and the --body-file= spelling', async () => {
    const rigged = await rig()

    const piped = await gh(rigged, ['pr', 'comment', '7', '-F', '-'], {}, 'From stdin.\n')
    expect(bodyOf(piped.lines)).toBe('From stdin.\n\n<!-- orca-bot:Scout -->')

    const joined = await gh(rigged, ['issue', 'comment', '12', `--body-file=${rigged.body}`])
    expect(bodyOf(joined.lines)).toBe('Reviewed the diff.\n\n<!-- orca-bot:Scout -->')
  })

  it('takes the attached short forms gh accepts', async () => {
    const rigged = await rig()

    const attached = await gh(rigged, ['pr', 'comment', '7', '-bLooks good.'])
    expect(bodyOf(attached.lines)).toBe('Looks good.\n\n<!-- orca-bot:Scout -->')

    const file = await gh(rigged, ['issue', 'comment', '12', `-F${rigged.body}`])
    expect(bodyOf(file.lines)).toBe('Reviewed the diff.\n\n<!-- orca-bot:Scout -->')
  })

  it('marks the body gh would post when a body flag repeats', async () => {
    const rigged = await rig()

    const { lines } = await gh(rigged, ['pr', 'comment', '7', '-b', 'first', '-b', 'second'])

    expect(argsOf(lines).slice(0, 4)).toEqual(['pr', 'comment', '7', '--body'])
    expect(bodyOf(lines)).toBe('second\n\n<!-- orca-bot:Scout -->')
  })

  it('finds the verb past a persistent --repo, and marks a pull request body', async () => {
    const rigged = await rig()

    const short = await gh(rigged, ['pr', '-R', 'acme/web', 'comment', '7', '-b', 'Looks good.'])
    expect(argsOf(short.lines).slice(0, 5)).toEqual(['pr', '-R', 'acme/web', 'comment', '7'])
    expect(bodyOf(short.lines)).toContain('<!-- orca-bot:Scout -->')

    const long = await gh(rigged, ['issue', '--repo=acme/web', 'edit', '12', '--body', 'Fixed.'])
    expect(bodyOf(long.lines)).toBe('Fixed.\n\n<!-- orca-bot:Scout -->')

    const created = await gh(rigged, ['pr', 'create', '--title', 'A fix', '--body', 'It fixes.'])
    expect(bodyOf(created.lines)).toBe('It fixes.\n\n<!-- orca-bot:Scout -->')
  })

  it('marks nothing when the body is empty, which would post a blank comment', async () => {
    const rigged = await rig()

    const { lines } = await gh(rigged, ['pr', 'comment', '7', '-b', ''])

    expect(argsOf(lines)).toEqual(['pr', 'comment', '7', '-b', ''])
  })

  it('passes every other call through untouched', async () => {
    const rigged = await rig()
    for (const argv of [
      ['pr', 'view', '7', '--json', 'body'],
      ['api', 'repos/acme/web/issues/12/comments', '-f', 'body=hi'],
      ['pr', 'comment', '7', '--body-file', 'missing.md']
    ]) {
      const { lines } = await gh(rigged, argv)
      expect(argsOf(lines)).toEqual(argv)
    }
  })

  it("keeps a failing gh's exit code, and marks nothing it cannot read", async () => {
    const rigged = await rig()

    const failed = await gh(rigged, ['pr', 'view', '7'], { FAKE_GH_STATUS: '4' })
    expect(failed.code).toBe(4)
    expect(argsOf(failed.lines)).toEqual(['pr', 'view', '7'])

    const noBody = await gh(rigged, ['pr', 'review', '7', '--approve'])
    expect(argsOf(noBody.lines)).toEqual(['pr', 'review', '7', '--approve'])
  })

  it('reads the marker back, and says nothing when a body carries none', () => {
    expect(botGhMarkerOf('looks good\n\n<!-- orca-bot:Scout -->\n')).toBe('Scout')
    expect(botGhMarkerOf('looks good')).toBeNull()
    expect(botGhMarkerOf(undefined)).toBeNull()
  })

  it('keeps a name from breaking the marker it writes or the comment it sits in', () => {
    const marker = botGhMarker('Docs > nightly -- build')

    expect(marker).toBe('<!-- orca-bot:Docs nightly - build -->')
    // A `>` would break the read-back; `-->` would end the comment and render the rest.
    expect(botGhMarkerOf(`body\n\n${marker}`)).toBe('Docs nightly - build')
    expect(botGhMarker('')).toBe('<!-- orca-bot:bot -->')
  })

  it("writes a named bot's shim, and none for a launch that cannot name it", async () => {
    const installed = await botGhShimEnv({ id: `test-${process.pid}`, name: 'Scout' })
    const dir = installed.ORCA_BOT_GH_SHIM_DIR

    expect(dir).toContain('.gh-shims')
    expect(await readFile(join(dir!, 'gh'), 'utf8')).toBe(botGhShimScript(botGhMarker('Scout')))
    expect(await botGhShimEnv({ id: `test-${process.pid}` })).toEqual({})
  })

  it('puts the shim first on PATH and takes its own key back out', () => {
    const env = withBotGhShimOnPath({
      PATH: '/usr/bin:/bin',
      ORCA_BOT_GH_SHIM_DIR: '/bots/.gh-shims/bot-1'
    })

    expect(env.PATH).toBe(`/bots/.gh-shims/bot-1${':'}/usr/bin:/bin`)
    expect(env).not.toHaveProperty('ORCA_BOT_GH_SHIM_DIR')
    expect(withBotGhShimOnPath({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
