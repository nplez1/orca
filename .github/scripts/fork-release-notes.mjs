#!/usr/bin/env node
// Renders the body of a fork release: a change summary derived from git, then the static
// install/project sections from .github/fork-release-notes.md.
//
// Why generated: the notes used to be install instructions plus a hand-maintained "Worth knowing"
// list, so a reader could not tell what a given build actually changed. Every bullet here comes from
// the commits the build contains, so nobody has to remember to update it.
//
// Why it never exits non-zero: a release must not fail because a shallow checkout or an unexpected
// git state left the summary unavailable. It warns on stderr and emits the notes without it.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const DEFAULT_TEMPLATE = resolve(REPO_ROOT, '.github/fork-release-notes.md')
const DEFAULT_REPO = 'nplez1/orca'
const SUMMARY_PLACEHOLDER = '{{CHANGE_SUMMARY}}'
const GIT_MAX_BUFFER = 64 * 1024 * 1024

// Why: tags without the -np. suffix are upstream's releases. They are not this feed's previous
// release, so comparing against one would describe upstream's history as this fork's change.
const FORK_RELEASE_TAG = /^v\d+\.\d+\.\d+-np\.\d+$/

// A reader updates for features and fixes. The fork-patch group is why this build differs from
// upstream's, but it is bookkeeping to that reader, and the maintenance tail is bookkeeping to
// everyone — so the product changes lead and the noise trails.
const GROUP_ORDER = ['feat', 'fix', 'perf', 'refactor', 'local', 'docs', 'test', 'other', 'chore']

// The fork-patch group stays visible without spending a whole screen on sync and release-record
// commits, which are the bulk of it in a range this size.
const FORK_PATCH_LIMIT = 6

const GROUP_TITLES = {
  local: 'Fork patches (`local(...)`) — what makes this build different',
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Documentation',
  test: 'Tests',
  chore: 'Maintenance',
  other: 'Other changes'
}

// ci/build/style are maintenance to a reader; a revert is neither a feature nor a fix.
const TYPE_GROUPS = {
  local: 'local',
  feat: 'feat',
  fix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  docs: 'docs',
  test: 'test',
  chore: 'chore',
  ci: 'chore',
  build: 'chore',
  style: 'chore',
  revert: 'other'
}

const SIGNING_PARAGRAPHS = {
  signed:
    '**Signed and notarized.** This build carries a Developer ID signature and a stapled Apple notarization ticket, so it opens with no Gatekeeper override and macOS keeps its permission grants across updates.',
  unsigned:
    '**Unsigned validation build — not for deployment.** Gatekeeper requires a manual override on first launch, and macOS treats each build as a new app, so permission grants will not survive an update.'
}

function warn(message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '
  process.stderr.write(`${prefix}${message}\n`)
}

// Progress the run does not need to act on: stderr, but not an annotation on the run summary.
function info(message) {
  process.stderr.write(`${message}\n`)
}

// GitHub wraps prose itself; wrapping here keeps the raw body readable in the release editor and in
// a diff of the generated notes.
function wrap(text, width = 100) {
  const paragraphs = text.split('\n\n')
  return paragraphs
    .map((paragraph) => {
      const lines = []
      let line = ''
      for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
        if (line.length > 0 && line.length + 1 + word.length > width) {
          lines.push(line)
          line = word
        } else {
          line = line.length === 0 ? word : `${line} ${word}`
        }
      }
      if (line.length > 0) {
        lines.push(line)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function parseArgs(argv) {
  const flags = {
    '--version': 'version',
    '--sha': 'sha',
    '--signing': 'signing',
    '--prev-tag': 'prevTag',
    '--repo': 'repo',
    '--template': 'template',
    '--out': 'out',
    '--max-per-group': 'maxPerGroup',
    '--first-release-window': 'firstReleaseWindow'
  }
  const options = {
    repo: DEFAULT_REPO,
    template: DEFAULT_TEMPLATE,
    maxPerGroup: 12,
    firstReleaseWindow: 60
  }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    const separator = raw.indexOf('=')
    const flag = separator === -1 ? raw : raw.slice(0, separator)
    const key = flags[flag]
    if (key == null) {
      throw new Error(`unknown argument ${raw}`)
    }

    let value = separator === -1 ? undefined : raw.slice(separator + 1)
    if (value == null) {
      index += 1
      value = argv[index]
    }
    if (value == null || value.length === 0) {
      throw new Error(`${flag} needs a value`)
    }

    if (key === 'maxPerGroup' || key === 'firstReleaseWindow') {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer, got "${value}"`)
      }
      options[key] = parsed
    } else {
      options[key] = value
    }
  }

  return options
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER
  })
  if (result.error != null) {
    return { ok: false, error: result.error.message }
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? '').trim() || `git ${args[0]} failed` }
  }
  return { ok: true, out: result.stdout ?? '' }
}

function listCommits(rangeArgs) {
  const result = git(['log', '--no-color', '--format=%H%x00%s%x00%p', ...rangeArgs])
  if (!result.ok) {
    throw new Error(result.error)
  }

  return result.out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, subject = '', parents = ''] = line.split('\u0000')
      return {
        sha,
        subject,
        parents: parents
          .trim()
          .split(' ')
          .filter((parent) => parent.length > 0)
      }
    })
    .filter((commit) => commit.subject.trim().length > 0)
}

// A rebase replays the same work as new commits, so `<prev>..HEAD` reports commits the previous
// release already contains. `git cherry` asks git itself which of them are patch-equivalent (same
// diff, new sha) instead of guessing from subjects; merges are outside what it compares, and are
// reported in the lead rather than as bullets. Undefined means the check could not run, in which
// case the range is counted as-is rather than silently.
function alreadyInPrevShas(prevTag) {
  const result = git(['cherry', prevTag, 'HEAD'])
  if (!result.ok) {
    warn(
      `could not check which commits are already in ${prevTag} (${result.error}); ` +
        `counting every commit in the range`
    )
    return undefined
  }

  const shas = new Set()
  for (const line of result.out.split('\n')) {
    const match = /^- ([0-9a-f]{40})(?:\s|$)/.exec(line)
    if (match != null) {
      shas.add(match[1])
    }
  }
  return shas
}

function tagExists(tag) {
  return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).ok
}

function headSha() {
  const result = git(['rev-parse', 'HEAD'])
  return result.ok ? result.out.trim() : ''
}

// The newest fork release tag that is neither this build nor a later one. Ancestry is deliberately
// not required: a rebase or an archive branch can leave the previous tag off HEAD's own line, which
// is the normal state of this fork's history.
function detectPrevTag(head) {
  const listed = git(['tag', '--list', '--sort=-v:refname'])
  if (!listed.ok) {
    return undefined
  }

  for (const tag of listed.out.split('\n').map((line) => line.trim())) {
    if (!FORK_RELEASE_TAG.test(tag) || !tagExists(tag)) {
      continue
    }
    const commit = git(['rev-parse', `${tag}^{commit}`])
    if (commit.out.trim() === head) {
      continue
    }
    if (!git(['merge-base', '--is-ancestor', 'HEAD', tag]).ok) {
      return tag
    }
  }
  return undefined
}

// Upstream subjects end with "(#24261)", sometimes two of them. The compare link carries the
// provenance, and a page of ticket numbers drowns the prose.
function stripTrailingRefs(text) {
  let result = text.trim()
  for (;;) {
    const match = result.match(/\s*\(([^()]*)\)$/)
    if (match == null || !/#\d+|[A-Z]{2,}-\d+/.test(match[1])) {
      return result
    }
    result = result.slice(0, match.index).trim()
  }
}

function classify(subject) {
  const match = subject.match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/)
  if (match == null) {
    return { group: 'other', scope: undefined, text: stripTrailingRefs(subject), type: 'other' }
  }

  const text = stripTrailingRefs(match[3])
  if (text.length === 0) {
    return { group: 'other', scope: undefined, text: stripTrailingRefs(subject), type: 'other' }
  }

  const scope = match[2] == null || match[2].length === 0 ? undefined : match[2]
  // `docs(fork)` records this fork's own sync and release process: bookkeeping, like the
  // maintenance tail, rather than documentation of the product.
  const bookkeeping = match[1] === 'docs' && scope === 'fork'
  return {
    group: bookkeeping ? 'chore' : (TYPE_GROUPS[match[1]] ?? 'other'),
    scope,
    text,
    type: match[1]
  }
}

function mergeLabel(subject) {
  return subject.replace(/^Merge (remote-tracking )?/, '').replace(/\s+into\s+\S+$/, '')
}

function describeMerges(commits) {
  return commits
    .filter((commit) => commit.parents.length > 1)
    .map((commit) => {
      const branch = commit.subject.match(/Merge (?:remote-tracking )?branch '([^']+)'/)?.[1]
      const counted = git(['rev-list', '--count', `${commit.parents[0]}..${commit.parents[1]}`])
      return {
        label: branch ?? mergeLabel(commit.subject),
        broughtIn: counted.ok ? Number.parseInt(counted.out.trim(), 10) : undefined
      }
    })
}

// A rebase can leave the same subject on two commits; a "(x7)" suffix says the repeats are real
// commits without spending seven bullets on "Update README downloads badge".
function dedupe(entries) {
  const seen = new Map()
  const unique = []
  for (const entry of entries) {
    const key = `${entry.scope ?? ''}\u0000${entry.text}`
    const existing = seen.get(key)
    if (existing == null) {
      const item = { ...entry, count: 1 }
      seen.set(key, item)
      unique.push(item)
    } else {
      existing.count += 1
    }
  }
  return unique
}

function renderGroup(title, entries, maxPerGroup) {
  if (entries.length === 0) {
    return []
  }

  const visible = entries.slice(0, maxPerGroup)
  const hidden = entries.slice(maxPerGroup).reduce((total, entry) => total + entry.count, 0)

  const lines = [`### ${title}`, '']
  for (const entry of visible) {
    const scope = entry.scope == null ? '' : `**${entry.scope}:** `
    const repeat = entry.count > 1 ? ` (x${entry.count})` : ''
    lines.push(`- ${scope}${entry.text}${repeat}`)
  }
  if (hidden > 0) {
    // The comparison link is in the lead; repeating a long URL after every group is worse than no
    // link at all.
    lines.push('', `_…and ${hidden} more commit${hidden === 1 ? '' : 's'} in this group._`)
  }
  lines.push('')
  return lines
}

// Commits that only bookkeep the repository are the loudest part of a range this size and the least
// useful to a reader; the count and its breakdown say more here than twelve bullets of it would.
function renderCompactGroup(title, entries) {
  if (entries.length === 0) {
    return []
  }

  const byType = new Map()
  for (const entry of entries) {
    byType.set(entry.type, (byType.get(entry.type) ?? 0) + entry.count)
  }
  const breakdown = [...byType.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `\`${type}\` ${count}`)
    .join(', ')
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const prose =
    `${total} commit${total === 1 ? '' : 's'} of maintenance and fork bookkeeping (${breakdown}), ` +
    `counted rather than listed; the commit list for this release has the details.`

  return [`### ${title}`, '', wrap(prose), '']
}

// Every line of a blockquote needs the marker, so this cannot go through plain wrap().
function wrapBlockquote(text, width = 100) {
  return wrap(text, width - 2)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function renderLead({
  prevTag,
  missingTag,
  firstRelease,
  total,
  rangeTotal,
  alreadyInPrev,
  merges,
  forkPatchCount,
  windowSize,
  compareUrl
}) {
  const mergeClause = merges.length === 0 ? '' : describeMergeClause(merges)

  if (prevTag != null) {
    const heading = `## What changed since \`${prevTag}\``
    // The range of a rebased branch contains commits the previous release already shipped, as new
    // shas with identical patches (`git cherry` finds them). Counting them would overstate what
    // changed, so the headline counts what the check left and says what the range held.
    const rangeClause =
      alreadyInPrev === 0
        ? ''
        : ` (${rangeTotal} commit${rangeTotal === 1 ? '' : 's'} ` +
          `${rangeTotal === 1 ? 'is' : 'are'} in the range; ${alreadyInPrev} of them ` +
          `${alreadyInPrev === 1 ? 'is' : 'are'} already in that release as ` +
          `${alreadyInPrev === 1 ? 'a rebased copy' : 'rebased copies'} — same patch, new commit)`
    const prose =
      `${total} commit${total === 1 ? '' : 's'} changed since the last release${rangeClause}, including ` +
      `**${forkPatchCount} fork patch${forkPatchCount === 1 ? '' : 'es'}** (\`local(...)\`)${mergeClause}. ` +
      `Changes are grouped by type below, newest first; a group that is capped says how many ` +
      `commits it left out.`
    return [heading, '', wrap(prose), '', compareLink(rangeTotal ?? total, compareUrl), '']
  }

  const heading = '## What changed'
  const note =
    missingTag == null
      ? null
      : wrapBlockquote(
          `**Note:** \`${missingTag}\` is not in this checkout, so the summary starts at the current ` +
            `tip instead of comparing against it. A shallow clone is the usual cause; the release is ` +
            `published either way.`
        )
  const prose = firstRelease
    ? `This is the first release, so there is no earlier release tag to compare against. ` +
      `**${forkPatchCount} fork patch${forkPatchCount === 1 ? '' : 'es'}** (\`local(...)\`) ` +
      `${forkPatchCount === 1 ? 'is' : 'are'} listed in full, and the ` +
      `${windowSize} most recent commits are summarized by type below.`
    : `**${forkPatchCount} fork patch${forkPatchCount === 1 ? '' : 'es'}** (\`local(...)\`) ` +
      `${forkPatchCount === 1 ? 'is' : 'are'} listed in full, and the ` +
      `${windowSize} most recent commits are summarized by type below.`
  return [heading, '', ...(note == null ? [] : [note, '']), wrap(prose), '']
}

// A single unbreakable line: wrapping splits the link text from its URL and leaves a stray arrow.
function compareLink(total, compareUrl) {
  if (compareUrl == null) {
    return ''
  }
  return `[${total === 1 ? 'The single commit' : `All ${total} commits`} in the comparison →](${compareUrl})`
}

function describeMergeClause(merges) {
  if (merges.length === 1) {
    const [merge] = merges
    return merge.broughtIn == null
      ? ` and a merge of \`${merge.label}\``
      : ` and ${merge.broughtIn} commits merged in from \`${merge.label}\``
  }
  if (merges.length > 2) {
    return ` and ${merges.length} merges`
  }
  const labels = merges.map((merge) => `\`${merge.label}\``).join(', ')
  return ` and ${merges.length} merges (${labels})`
}

function buildSummary(options, context) {
  const { commits, prevTag, missingTag, tag, rangeTotal, alreadyInPrev } = context
  // A tag that was expected but is absent is not a first release: the note above the summary says
  // what actually happened.
  const firstRelease = prevTag == null && missingTag == null
  const mergeCommits = commits.filter((commit) => commit.parents.length > 1)
  const merges = describeMerges(mergeCommits)

  const buckets = new Map(GROUP_ORDER.map((group) => [group, []]))
  for (const commit of commits) {
    if (commit.parents.length > 1) {
      continue
    }
    const classified = classify(commit.subject)
    buckets.get(classified.group).push(classified)
  }

  const compareUrl =
    prevTag == null ? undefined : `https://github.com/${options.repo}/compare/${prevTag}...${tag}`

  const lines = renderLead({
    prevTag,
    missingTag,
    firstRelease,
    total: commits.length,
    rangeTotal,
    alreadyInPrev,
    merges,
    forkPatchCount: dedupe(buckets.get('local')).length,
    windowSize: options.firstReleaseWindow,
    compareUrl
  })

  if (commits.length === 0) {
    lines.push(
      (rangeTotal ?? 0) > 0
        ? `Every commit in \`${prevTag}..${tag}\` is already in \`${prevTag}\`, so this build ` +
            `contains no source change of its own.`
        : 'No commits landed since the last release, so this build repackages the same source.',
      ''
    )
  }

  for (const group of GROUP_ORDER) {
    const entries = dedupe(buckets.get(group))
    if (group === 'chore') {
      lines.push(...renderCompactGroup(GROUP_TITLES[group], entries))
      continue
    }
    // With a previous release the fork-patch group is a change list and stays short. Without one it
    // is the summary's main content — and the lead says it is listed in full — so it is not capped.
    const limit =
      group !== 'local'
        ? options.maxPerGroup
        : prevTag == null
          ? entries.length
          : Math.min(options.maxPerGroup, FORK_PATCH_LIMIT)
    lines.push(...renderGroup(GROUP_TITLES[group], entries, limit))
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

// No git, no history, or a subject list we could not read — the notes still have to be a valid
// release body, so this is the smallest honest thing to publish.
function renderFallbackSummary({ prevTag }) {
  const since = prevTag == null ? '' : ` since \`${prevTag}\``
  const prose =
    `**A change summary could not be generated${since}:** it is derived from the commits in this ` +
    `build, and git history for that range is not available here. The commits are listed in the ` +
    `release's own comparison view, and the \`fork-release.yml\` run log records the exact reason.`
  return ['## What changed', '', wrap(prose), ''].join('\n').trimEnd()
}

function loadSummary(options, context) {
  const { tag, prevTag, missingTag } = context
  const range =
    prevTag == null ? ['-n', String(options.firstReleaseWindow), 'HEAD'] : [`${prevTag}..HEAD`]
  const rangeCommits = listCommits(range)

  // Only the commits the previous release does not already contain describe this build's change;
  // the rest are the rebase's duplicates of it. Everything downstream sees the filtered list, so no
  // group and no count can report them as new.
  const equivalents = prevTag == null ? undefined : alreadyInPrevShas(prevTag)
  const commits =
    equivalents == null
      ? rangeCommits
      : rangeCommits.filter((commit) => !equivalents.has(commit.sha))
  const alreadyInPrev = rangeCommits.length - commits.length

  if (prevTag == null) {
    // Without a range there is no way to know which commits are the fork's own, except that the
    // patch series names itself; the rest of the summary stays inside the bounded window.
    const known = new Set(commits.map((commit) => commit.sha))
    for (const commit of listCommits(['HEAD'])) {
      if (!known.has(commit.sha) && /^local(\(|!?:)/.test(commit.subject)) {
        commits.push(commit)
        known.add(commit.sha)
      }
    }
  }

  return buildSummary(options, {
    commits,
    prevTag,
    missingTag,
    tag,
    rangeTotal: prevTag == null ? undefined : rangeCommits.length,
    alreadyInPrev
  })
}

function renderTemplate({ templatePath, template, version, sha, signing, summary }) {
  const signingKey = signing === 'true' || signing === 'signed' ? 'signed' : 'unsigned'
  const rendered = template
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{SHA}}', sha.slice(0, 10))
    .replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10))
    .replaceAll('{{SIGNING}}', SIGNING_PARAGRAPHS[signingKey])
    .replaceAll(SUMMARY_PLACEHOLDER, summary)

  if (!template.includes(SUMMARY_PLACEHOLDER)) {
    // The summary still has to lead, and losing it silently would be worse than a misplaced section.
    warn(`${SUMMARY_PLACEHOLDER} is missing from ${templatePath}; prepending the summary instead`)
    return `${summary}\n\n---\n\n${rendered}`
  }
  return rendered
}

function main(argv) {
  const options = parseArgs(argv)
  const version =
    options.version ?? JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).version
  const tag = version.startsWith('v') ? version : `v${version}`
  const sha = options.sha ?? process.env.GITHUB_SHA?.trim() ?? ''
  const resolvedSha = sha.length > 0 ? sha : headSha()

  let summary
  let missingTag = null
  let prevTag = options.prevTag
  try {
    const repo = git(['rev-parse', '--is-inside-work-tree'])
    if (!repo.ok) {
      throw new Error(repo.error)
    }
    // A shallow clone still answers `git log`, but the previous tag is a graft there, so it stops
    // excluding that tag's own ancestry: the range explodes into upstream's whole history and the
    // headline count is simply wrong. No summary beats a confidently wrong one.
    const shallow = git(['rev-parse', '--is-shallow-repository'])
    if (shallow.ok && shallow.out.trim() === 'true') {
      throw new Error(
        'this checkout is shallow, so the commit range since the previous release tag is not reliable'
      )
    }
    const head = headSha()
    if (prevTag != null && !tagExists(prevTag)) {
      warn(
        `previous release tag ${prevTag} is not in this checkout; summarizing from the tip instead`
      )
      missingTag = prevTag
      prevTag = undefined
    }
    if (prevTag == null && options.prevTag == null && head.length > 0) {
      prevTag = detectPrevTag(head)
      if (prevTag != null) {
        info(`comparing against the newest fork release tag ${prevTag}`)
      }
    }

    summary = loadSummary(options, { tag, prevTag, missingTag })
  } catch (error) {
    warn(`change summary unavailable: ${error.message}`)
    summary = renderFallbackSummary({ prevTag })
  }

  const template = readFileSync(options.template, 'utf8')
  const body = `${renderTemplate({
    templatePath: options.template,
    template,
    version,
    sha: resolvedSha,
    signing: options.signing,
    summary
  })}\n`

  if (options.out == null) {
    process.stdout.write(body)
  } else {
    writeFileSync(options.out, body)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  // Last resort: the workflow creates the release from whatever lands in the notes file, so this
  // must still produce a body even when the template itself is unreadable.
  warn(`release notes generation failed: ${error.message}`)
  process.stdout.write(
    `**Orca NP release notes could not be generated.** See this run's log for the reason.\n`
  )
}
