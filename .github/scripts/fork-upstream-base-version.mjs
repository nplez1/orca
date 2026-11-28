#!/usr/bin/env node
// The base version a fork release is stamped with, so `<base>-np.<run number>` says which upstream Orca
// a build is comparable to.
//
// Why `package.json` cannot answer it: upstream bumps that number on its release line, so `main` can sit
// on an old one while releases keep shipping — on 2026-11-28 `main` declared 1.4.214 (unchanged since
// 1.4.214's own release on 2026-09-26) while the release tags had reached v1.4.279. Stamping 1.4.214 on
// a build that carries 1.4.279's code told a reader nothing about what they were running.
//
// Why the newest tag at or before the sync base: the base is the point in upstream's history this build
// contains (recorded by the sync, the same record `local/check-upstream-file-comments.mjs` keys to), so
// the newest release at or before it is the one the build is at least as new as. A tag cut after the
// base is upstream work this build does not carry, and naming it would overclaim.
//
// usage: fork-upstream-base-version.mjs [--explain]
// exit: 0 print the base version (X.Y.Z), 1 nothing readable, 2 usage
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { commitExists, readRecordedSyncBase } from '../../local/lib/upstream-sync-base.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** A release tag's version, or null for anything that is not one: the fork's own `-np.` tags, `-rc.`, `archive/`. */
export function parseUpstreamReleaseTag(name) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(name ?? '').trim())
  return match ? match.slice(1).join('.') : null
}

/** Version comparison on the triple only; a base version carries no suffix. */
export function compareBaseVersions(left, right) {
  const parts = (version) =>
    String(version ?? '')
      .split('.')
      .map(Number)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) {
      return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1
    }
  }
  return 0
}

/**
 * The base version for `{ tags, baseSeconds, fallback }`.
 *
 * `tags` are `{ name, seconds }` from the repository's tag list; the newest release tag whose date is at
 * or before the sync base wins. No eligible tag means the sync base predates every mirrored release —
 * the fallback (package.json) is then the only number there is, and the caller says so on stderr.
 */
export function pickUpstreamBase({ tags, baseSeconds, fallback }) {
  let best = null
  for (const tag of tags ?? []) {
    const version = parseUpstreamReleaseTag(tag.name)
    if (version === null || !Number.isFinite(tag.seconds)) {
      continue
    }
    if (baseSeconds !== null && tag.seconds > baseSeconds) {
      continue
    }
    if (best === null || compareBaseVersions(version, best.version) > 0) {
      best = { version, name: tag.name, seconds: tag.seconds }
    }
  }
  return best ?? { version: fallback, name: null, seconds: null }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/** Every tag with its creation time, as the election above wants it. */
function readTags(root) {
  const out = git(root, [
    'for-each-ref',
    '--format=%(refname:short) %(creatordate:unix)',
    'refs/tags'
  ])
  return out
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter(([name, seconds]) => name && seconds)
    .map(([name, seconds]) => ({ name, seconds: Number(seconds) }))
}

function baseSecondsOf(root, base, explain) {
  if (base === null) {
    explain('no recorded sync base; falling back to package.json')
    return null
  }
  if (!commitExists(root, base)) {
    explain(`the recorded sync base ${base.slice(0, 12)} is not in this clone; falling back`)
    return null
  }
  return Number(git(root, ['show', '-s', '--format=%ct', `${base}^{commit}`]))
}

function fallbackVersion(root) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const explain = (message) => process.stderr.write(`fork-upstream-base-version: ${message}\n`)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write('usage: fork-upstream-base-version.mjs [--explain]\n')
    return 0
  }
  if (argv.some((arg) => arg !== '--explain')) {
    process.stderr.write(`unknown argument: ${argv.find((arg) => arg !== '--explain')}\n`)
    return 2
  }
  const fallback = fallbackVersion(root)
  const base = readRecordedSyncBase(root)
  const baseSeconds = baseSecondsOf(root, base, explain)
  const { version, name } = pickUpstreamBase({
    tags: readTags(root),
    baseSeconds,
    fallback
  })
  if (name === null) {
    // Why a warning and not a refusal: a release must not stall on a missing tag mirror, but a silent
    // package.json number is the behaviour this script exists to replace.
    process.stderr.write(
      `::warning::no mirrored upstream release tag at or before the sync base; stamping package.json ${version}\n`
    )
  } else if (compareBaseVersions(version, fallback) !== 0) {
    process.stderr.write(
      `fork-upstream-base-version: ${name} is the newest upstream release at or before the sync base; ` +
        `package.json says ${fallback}\n`
    )
  }
  process.stdout.write(`${version}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
