import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { botGhMarker, botGhMarkerOf, botGhShimScript, withBotGhShimOnPath } from './fork-gh-shim'

const run = promisify(execFile)
const POSIX = process.platform !== 'win32'

// A fake gh that records its own argv, one per line, so a passthrough is compared byte for byte.
const FAKE_GH = [
  '#!/bin/sh',
  'printf "%s\\n" "$#" "$@"',
  '# FAKE_GH_DUMP: where to keep the body file gh was handed, before the shim cleans it up.',
  'if [ -n "${FAKE_GH_DUMP:-}" ]; then',
  '  prev=',
  '  for arg in "$@"; do',
  '    case $prev in --body-file|-F) cp -- "$arg" "$FAKE_GH_DUMP" ;; esac',
  '    prev=$arg',
  '  done',
  'fi',
  'exit ${FAKE_GH_STATUS:-0}',
  ''
].join('\n')

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

async function gh(
  rigged: { shim: string; shimDir: string; realDir: string },
  args: string[],
  env: Record<string, string> = {}
): Promise<{ lines: string[]; code: number }> {
  const path = [rigged.shimDir, rigged.realDir, '/usr/bin', '/bin'].join(':')
  try {
    const { stdout } = await run(rigged.shim, args, { env: { ...process.env, PATH: path, ...env } })
    return { lines: stdout.split('\n').slice(0, -1), code: 0 }
  } catch (error) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execFile rejects with the child's own Error carrying stdout and the exit code.
    const failed = error as { stdout?: string; code?: number }
    return { lines: (failed.stdout ?? '').split('\n').slice(0, -1), code: failed.code ?? 1 }
  }
}

const argsOf = (lines: string[]) => lines.slice(1)
const bodyOf = (lines: string[]) => lines.slice(2).join('\n')

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

  it('hands gh a marked copy of --body-file, leaving the bot’s own file alone', async () => {
    const rigged = await rig()

    const kept = join(rigged.shimDir, '..', 'kept.md')
    const { lines } = await gh(rigged, ['issue', 'comment', '12', '--body-file', rigged.body], {
      FAKE_GH_DUMP: kept
    })

    expect(argsOf(lines)[4]).not.toBe(rigged.body)
    expect(await readFile(kept, 'utf8')).toBe(`Reviewed the diff.\n\n<!-- orca-bot:Scout -->\n`)
    expect(await readFile(rigged.body, 'utf8')).toBe('Reviewed the diff.')
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
