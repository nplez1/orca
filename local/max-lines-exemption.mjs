#!/usr/bin/env node
// One max-lines exemption, written the way the ratchet reads it: a `-- Why:` header on the file's
// first line plus an `inline <path>` row in `config/max-lines-baseline.txt`. In the 2026-11-24 release
// session that pair was hand-written seven times, and the row was forgotten at least once.
//
//   node local/max-lines-exemption.mjs --add <path> --why <text>
//   node local/max-lines-exemption.mjs --list
//   node local/max-lines-exemption.mjs --help
//
// The budget is the oxlint rule's own (skipBlankLines + skipComments), read from the ratchet's
// `defaultLimitForPath` rather than restated here, so a cap change cannot leave this tool behind.
// Idempotent both ways: a header already in the file and a row already in the baseline are reported,
// never duplicated. A file under its budget is refused — the ratchet only grandfathers a file that
// needs the comment, and adding one there would fail the gate for no reason.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  defaultLimitForPath,
  hasMaxLinesDisable
} from '../config/scripts/static-analysis/ratchets/source-budget/check-max-lines-ratchet.mjs'
import { commitExists, commitHasPath, readRecordedSyncBase } from './lib/upstream-sync-base.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE = path.join('config', 'max-lines-baseline.txt')
// Same directive shapes the ratchet recognises, so a header this tool skips is one it would collect.
const DIRECTIVE = /(?:eslint|oxlint)-disable(?:-next-line|-line)?\b([^\n]*)/g

const HELP = `max-lines exemptions, as the ratchet reads them

usage
  node local/max-lines-exemption.mjs --add <path> --why <text>   write the header and the baseline row
  node local/max-lines-exemption.mjs --list                      current exemptions with their reasons
  node local/max-lines-exemption.mjs --help

--add writes \`/* eslint-disable max-lines -- Why: <text>. */\` as the file's first line (after a
shebang) and \`inline <path>\` in sorted position in ${BASELINE}. Both steps are skipped when
already present, so a rerun after a forgotten row repairs it and duplicates nothing.

It refuses a path that does not exist, a path git does not track (the ratchet scans the index, so that
row would be stale on arrival — \`git add\` it first), and a file under its budget. It warns, without
refusing, when the path is absent from the recorded sync base: the fork's rule is to split a
fork-owned file rather than exempt it, and local/max-lines-exemption.test.mjs fails on that row.
A row already recorded in that test's FORK_OWNED_EXCEPTIONS is exempt from the rule and is not
warned about; adding a path to it is a policy change, not part of this tool's job.`

/** The `-- Why:` text of a file's max-lines disable, or null when it carries none. */
export function maxLinesReason(sourceText) {
  for (const match of sourceText.matchAll(DIRECTIVE)) {
    // A hand-written header may wrap, so the reason runs to the end of the comment, not the line.
    const opened = sourceText.lastIndexOf('/*', match.index)
    const inBlock = opened !== -1 && sourceText.indexOf('*/', opened) > match.index
    const end = inBlock
      ? sourceText.indexOf('*/', match.index)
      : sourceText.indexOf('\n', match.index)
    const [rules, ...why] = sourceText.slice(match.index, end === -1 ? undefined : end).split('--')
    if (!/\bmax-lines\b/.test(rules)) {
      continue
    }
    const reason = why
      .join('--')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^Why:\s*/i, '')
    return reason || null
  }
  return null
}

/**
 * Non-blank, non-comment lines — what the oxlint rule counts with skipBlankLines + skipComments.
 * A `//` inside a string truncates its line, which can only under-count: the question here is
 * "over or under the budget", and a file that needs an exemption is over it by more than that.
 */
export function countCodeLines(sourceText) {
  const withoutBlocks = sourceText.replace(/\/\*[\s\S]*?\*\//g, '')
  let count = 0
  for (const line of withoutBlocks.split('\n')) {
    if (line.replace(/\/\/.*$/, '').trim() !== '') {
      count += 1
    }
  }
  return count
}

/** The recorded header, one line, so it never pushes the file past the budget it is exempting. */
export function exemptionHeader(why) {
  const reason = (why ?? '').trim().replace(/\s+/g, ' ').replace(/\.+$/, '')
  if (reason === '') {
    throw new Error('--why needs the reason the file cannot be split')
  }
  if (reason.includes('*/')) {
    throw new Error('--why cannot contain `*/` — it would close the comment early')
  }
  return `/* eslint-disable max-lines -- Why: ${reason}. */`
}

/** The file with the header added; unchanged when it already carries a max-lines disable. */
export function withExemptionHeader(sourceText, why) {
  if (hasMaxLinesDisable(sourceText)) {
    return sourceText
  }
  const header = exemptionHeader(why)
  const lines = sourceText.split('\n')
  if (lines[0].startsWith('#!')) {
    return [lines[0], header, ...lines.slice(1)].join('\n')
  }
  return [header, ...lines].join('\n')
}

/** The baseline with `row` in sorted position; byte-identical when it is already there. */
export function insertBaselineRow(text, row) {
  const lines = text.split('\n')
  const headerEnd = lines.findIndex((line) => !line.startsWith('#'))
  const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd)
  const rows = lines
    .slice(header.length)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (rows.includes(row)) {
    return text
  }
  rows.push(row)
  rows.sort()
  return `${[...header, ''].join('\n')}${rows.join('\n')}\n`
}

/** Every recorded exemption, with the reason the file itself carries. */
export function readExemptions(root = ROOT) {
  const entries = []
  for (const line of readFileSync(path.join(root, BASELINE), 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const [kind, file] = trimmed.split(/\s+/)
    if (!file) {
      continue
    }
    const source = path.join(root, file)
    const why =
      kind === 'inline' && existsSync(source) ? maxLinesReason(readFileSync(source, 'utf8')) : null
    entries.push({ kind, path: file, why })
  }
  return entries
}

function isTracked(root, relative) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relative], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A warning, not a refusal: the recorded base lags the current sync, so this can read stale. */
function ownershipWarning(root, relative) {
  const base = readRecordedSyncBase(root)
  if (base === null || !commitExists(root, base)) {
    return 'the recorded sync base is not in this clone, so upstream ownership was not checked'
  }
  if (commitHasPath(root, base, relative)) {
    return null
  }
  return `${relative} is fork-owned (absent from the recorded sync base ${base.slice(0, 10)}): the fork's rule is to split it, and local/max-lines-exemption.test.mjs fails on this row`
}

export function addExemption(root, target, why) {
  const absolute = path.resolve(root, target)
  const relative = path.relative(root, absolute)
  if (relative.startsWith('..')) {
    throw new Error(`${target} is outside ${root}`)
  }
  if (!existsSync(absolute)) {
    throw new Error(`${relative} does not exist`)
  }
  if (!isTracked(root, relative)) {
    throw new Error(
      `${relative} is not tracked: the ratchet scans git's index, so a row for it is stale on arrival — git add it first`
    )
  }
  const source = readFileSync(absolute, 'utf8')
  const limit = defaultLimitForPath(relative)
  const counted = countCodeLines(source)
  if (counted <= limit) {
    throw new Error(
      `${relative} is at ${counted} of its ${limit} non-blank, non-comment lines — under the budget, so it needs no exemption`
    )
  }
  const header = withExemptionHeader(source, why)
  const wroteHeader = header !== source
  if (wroteHeader) {
    writeFileSync(absolute, header)
  }
  const baselineFile = path.join(root, BASELINE)
  const before = readFileSync(baselineFile, 'utf8')
  const after = insertBaselineRow(before, `inline ${relative}`)
  if (after !== before) {
    writeFileSync(baselineFile, after)
  }
  return {
    path: relative,
    counted,
    limit,
    wroteHeader,
    wroteRow: after !== before,
    ownership: ownershipWarning(root, relative)
  }
}

function parseArgs(argv) {
  const options = { add: null, why: null, list: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      options.help = true
      continue
    }
    if (flag === '--list') {
      options.list = true
      continue
    }
    if (flag === '--add' || flag === '--why') {
      const value = argv[index + 1] ?? null
      index += 1
      if (value === null) {
        throw new Error(`${flag} needs a value`)
      }
      if (flag === '--add') {
        options.add = value
      } else {
        options.why = value
      }
      continue
    }
    throw new Error(`unknown argument: ${flag}`)
  }
  if (options.list && options.add !== null) {
    throw new Error('pick one of --add <path> --why <text> or --list')
  }
  if (!options.list && !options.help && options.add === null) {
    throw new Error('pick one of --add <path> --why <text> or --list')
  }
  if (options.add !== null && options.why === null) {
    throw new Error('--add needs --why <text>: the baseline records what, the header records why')
  }
  return options
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`max-lines-exemption: ${error.message}`)
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }
  try {
    if (options.list) {
      const entries = readExemptions(root)
      console.log(`${entries.length} max-lines exemption(s) in ${BASELINE}`)
      for (const entry of entries) {
        const reason =
          entry.why ??
          (entry.kind === 'inline'
            ? '(no -- Why: reason in the file)'
            : 'mobile/.oxlintrc.json max-lines bump')
        console.log(`  ${entry.kind.padEnd(13)} ${entry.path} — ${reason}`)
      }
      return 0
    }
    const outcome = addExemption(root, options.add, options.why)
    const header = outcome.wroteHeader ? 'header written' : 'header already present'
    const row = outcome.wroteRow ? 'baseline row added' : 'baseline row already present'
    console.log(
      `max-lines: ${outcome.path} at ${outcome.counted} of ${outcome.limit} — ${header}, ${row}`
    )
    if (outcome.ownership) {
      console.error(`max-lines: warning — ${outcome.ownership}`)
    }
    return 0
  } catch (error) {
    console.error(`max-lines-exemption: ${error.message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
