#!/usr/bin/env node
/**
 * Identity sweep — the gate for the `local(identity)` patch ("this fork ships as Orca NP").
 *
 * Every upstream sync re-introduces names this fork renamed and nothing else catches them: the last
 * sync needed `Orca.Tabular`, the jcode/qoder `/home/dev/.orca/agent-hooks` test paths, and
 * `orca-dev`/`orca.exe` expectations found by hand while reading conflicts. Rename list:
 * LOCAL-PATCHES.md `local(identity)`. A `fix` rule is a mechanical literal that `--fix` rewrites; a
 * rule without a replacement template is a real violation awaiting a decision, mostly the `~/.orca`
 * readers, where re-pointing a path is a per-store data migration. Both kinds fail the gate.
 *
 * Usage: node local/sync/identity-sweep.mjs [--json | --fix | --help]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCAN_ROOTS = ['src', 'config', 'mobile', 'resources', 'native', '.github/workflows']
const EXTENSIONS = new Set(
  'ts tsx js jsx mjs cjs json jsonc yml yaml md sh ps1 cmd nsh nsi rs toml swift'.split(' ')
)
/** Above this size a file is a recorded payload rather than source; it is skipped and counted. */
const MAX_BYTES = 1_500_000

// Allowlist: [pattern, why, paths?, when?]. `pattern` is tested against the matched text alone;
// `paths` scopes an entry to a file set and `when` to lines that name the exception explicitly.
const NATIVE = /native\/windows-cli-launcher/
const NATIVE_OR_BUILD = /windows-cli-launcher|build-windows-cli-launcher/
const RELAY_PATHS = /ssh-remote-|orca-cli-command-name|agent-launch-remote|src\/relay\//
const LOCALES = /i18n\/locales\//
const RELAY_WHY =
  'the SSH relay deploys a fixed plain `orca` / `orca.cmd`; it must not follow the rename.'
const LINUX_WHY =
  'the Linux deb/rpm identity (`executableName: orca-ide`) is deliberately NOT renamed.'
const ALLOWLIST = [
  [/orca:\/\//, 'the URL scheme stays `orca://` — official clients and the mobile app consume it.'],
  [/orcanpm|Orca ?NP/, "already the fork's own name; nothing to rewrite."],
  [/orca-terminal-daemon\.exe/, 'legacy daemon executable name, kept so old installs are reaped.'],
  [/Orca\.exe/, 'the Rust launcher deliberately tries `Orca.exe` then `Orca NP.exe`.', NATIVE],
  [
    /orca\.exe/,
    'the native launcher is built as `orca.exe`; extraResources maps it to bin/orca-np.exe.',
    NATIVE_OR_BUILD
  ],
  [/^orca(?:\.cmd)?$/, RELAY_WHY, null, /relay|\.orca-relay|ORCA_CLI_COMMAND/i],
  [/^(?:bin[\\/])?orca(?:\.cmd|\.exe)?$/, RELAY_WHY, RELAY_PATHS],
  [/orca-ide/, LINUX_WHY, /linux|appimage|docker/i],
  [/orca-ide/, LINUX_WHY, null, /linux|appimage|\.deb|\.rpm|debian|ubuntu|gnome/i],
  [/com\.stably\.orca\.mobile/, 'the released mobile client keeps its upstream bundle id.'],
  [/stablyai\/orca/, 'archive/backup reference to the upstream repository and its artifacts.'],
  [/orca|\.orca/, 'translated copy stays as it is (LOCAL-PATCHES, "Translated copy").', LOCALES]
]

// Rules, in priority order: the first to claim a match owns it, so the ambiguous catch-alls sit below
// the mechanical ones. A rule is [id, pattern, fix template?, filters?]; without a template it is
// report-only and its reason comes from WHY. Filters run against the line (`anchor`, `lineIs`,
// `lineNot`), the file (`paths`, `notPaths`, `evidence`) or the preceding `contextBack` lines.
const HOME_SEGMENT = /(?<![\w.-])\.orca(?![\w-])/g
const HOME_ANCHOR =
  /~\/|homedir\(|\/home\/|\/Users\/|[A-Za-z]:\\+Users|\bHOME\b|home(?:Dir|Path|Root)?\b/
const FIXTURE_PATHS = /\.(?:test|spec)\.[cm]?[jt]sx?$|^config\/scripts\/|fixtures?|__tests__/
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#|;|<!--)/
/** Upstream owns its release workflows; this fork does not run them, so renaming in them is sync churn. */
const UPSTREAM_WORKFLOWS = /^\.github\/workflows\//
const CLI_POSITION =
  /['"`]orca['"`]\s*(?:serve|orchestration|worktree|repo|skills|browser|emulator|computer|--)|(?:command|executable|launcher|cli)[\w]*\s*[:=]\s*['"`][^'"\n]*[\\/]?orca['"`]|\b(?:which|command -v|spawn|execFile|exec)\b[^)]{0,40}['"`]orca['"`]|\bORCA_CLI_COMMAND\b[^'"\n]{0,30}['"`]orca['"`]/i
const APP_DATA_ROOT =
  /(?:LOCALAPPDATA|Application Support|XDG_CONFIG_HOME|Roaming|appData)[^'"\n]{0,24}[\\/]orca(?![-\w])/g
// Why `evidence`: where the reader itself still says `.orca`, rewriting the expectation alone would
// fail the suite. Why `contextNot`: a fixture naming a *stale* `.orca` hook on purpose is not a left-over.
const HOME_FIXTURE = {
  anchor: HOME_ANCHOR,
  paths: FIXTURE_PATHS,
  lineNot: COMMENT_LINE,
  notPaths: /^src\/relay\//,
  contextBack: 4,
  contextNot: /stale|legacy|previous|retired/i,
  evidence: (file, source) => source.includes('.orca-np') || file.startsWith('config/scripts/')
}
const IN_COMMENT = { anchor: HOME_ANCHOR, lineIs: COMMENT_LINE }
const HOME_ONLY = { anchor: HOME_ANCHOR }
const CLI_POS = { anchor: CLI_POSITION }
const WHY = {
  'home-dir-comment': 'prose, not a path anyone resolves — "the real ~/.orca" is the official one.',
  'home-dir-reader': 'a per-store data migration, not a constant swap (LOCAL-PATCHES).',
  'home-dir-unknown': 'the per-repo `.orca/` convention is deliberately NOT renamed.',
  'app-data-root': "the fork's roots are orca-np (`%LOCALAPPDATA%\\orca-np\\daemon-host`).",
  'cli-dev-name': "also this repo's own npm bin and its dev userData directory.",
  'cli-ide-name': 'the Linux deb/rpm name is deliberate (allowlisted): a legacy list, or new?',
  'win-app-exe': 'the launcher fallback, installer lists and app probes name it.',
  'win-launcher-exe': "the launcher's build output is legitimately `orca.exe`; only `bin/` is not.",
  'bundle-id': "the fork's appId is `com.nplez1.orca` — or is this the official app?",
  'bare-cli-name': 'a bare `orca` is also a git owner, a provider id, a workspace name, prose.',
  'upstream-owned-workflow':
    'upstream-owned release workflow this fork does not run; renaming inside it only conflicts at sync.'
}
const RULES = [
  ['upstream-owned-workflow', /(?:bin[\\/])orca\.exe/g, undefined, { paths: UPSTREAM_WORKFLOWS }],
  ['nsis-progid', /Orca\.(Markdown|Tabular)\b/g, 'OrcaNP.$1'],
  ['packaged-launcher-path', /(bin)([\\/])orca\.exe/g, '$1$2orca-np.exe'],
  ['home-dir-fixture', HOME_SEGMENT, '.orca-np', HOME_FIXTURE],
  ['home-dir-comment', HOME_SEGMENT, undefined, IN_COMMENT],
  ['home-dir-reader', HOME_SEGMENT, undefined, HOME_ONLY],
  ['home-dir-unknown', HOME_SEGMENT],
  ['app-data-root', APP_DATA_ROOT],
  ['cli-dev-name', /(?<![-\w])orca-dev(?![-\w])/g],
  ['cli-ide-name', /(?<![-\w])orca-ide(?![-\w])/g],
  ['win-app-exe', /(?<![-\w])Orca\.exe(?![-\w])/g],
  ['win-launcher-exe', /(?<![-\w])orca\.exe(?![-\w])/g],
  ['bundle-id', /com\.stably(?:ai)?\.orca/g],
  ['bare-cli-name', /(?<![-\w.])orca(?![-\w])/g, undefined, CLI_POS]
]
const isFixable = (hit) => hit.fix !== undefined
// Why: `--json | head` is a normal thing to do; a closed reader is not an error worth a stack trace.
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE') {
    throw error
  }
})
const expand = (template, parts) => template.replace(/\$(\d)/g, (_, group) => parts[group] ?? '')

function listFiles() {
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }
  const rg = spawnSync('rg', ['--files', ...SCAN_ROOTS], opts)
  if (rg.stdout) {
    return rg.stdout.split('\n').filter(Boolean)
  }
  process.stderr.write('identity-sweep: rg not found; falling back to a filesystem walk\n')
  const files = []
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        files.push(relative(REPO_ROOT, path))
      }
    })
  SCAN_ROOTS.forEach((root) => walk(join(REPO_ROOT, root)))
  return files
}

function allowlistReason(file, line, text) {
  const one = ALLOWLIST.find(
    (e) => e[0].test(text) && (!e[2] || e[2].test(file)) && (!e[3] || e[3].test(line))
  )
  return one?.[1] ?? null
}

function filteredOut(file, source, line, lines, index, filter) {
  if (!filter) {
    return false
  }
  if (filter.paths && !filter.paths.test(file)) {
    return true
  }
  if (filter.notPaths?.test(file)) {
    return true
  }
  if (filter.evidence && !filter.evidence(file, source)) {
    return true
  }
  if (filter.lineIs && !filter.lineIs.test(line)) {
    return true
  }
  if (filter.lineNot?.test(line)) {
    return true
  }
  if (filter.anchor && !filter.anchor.test(line)) {
    return true
  }
  const from = Math.max(0, index - (filter.contextBack ?? 0))
  return Boolean(filter.contextNot?.test(lines.slice(from, index).join('\n')))
}

function scanFile(file, source) {
  const hits = []
  const lines = source.split('\n')
  const add = (id, template, match, at, line) => {
    const start = match.index
    const end = start + match[0].length
    if (hits.some((h) => h.line === at && start < h.start + h.text.length && end > h.start)) {
      return
    }
    const fix = template && expand(template, [...match])
    const allowed = allowlistReason(file, line, match[0])
    hits.push({ id, file, line: at, start, text: match[0], fix, allowed })
  }
  lines.forEach((line, index) => {
    for (const [id, pattern, template, filter] of RULES) {
      if (filteredOut(file, source, line, lines, index + 1, filter)) {
        continue
      }
      for (const match of line.matchAll(pattern)) {
        add(id, template, match, index + 1, line)
      }
    }
  })
  return hits
}

function scan() {
  const violations = []
  const allowed = []
  let files = 0
  let skipped = 0
  for (const file of listFiles()) {
    if (!EXTENSIONS.has(file.slice(file.lastIndexOf('.') + 1))) {
      continue
    }
    let source = null
    try {
      source = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch {
      source = null
    }
    if (source === null || source.length > MAX_BYTES || source.includes('\0')) {
      skipped += 1
      continue
    }
    files += 1
    for (const hit of scanFile(file, source)) {
      ;(hit.allowed ? allowed : violations).push(hit)
    }
  }
  return { violations, allowed, files, skipped }
}

function applyFixes(violations) {
  const changed = []
  for (const file of new Set(violations.filter(isFixable).map((hit) => hit.file))) {
    const hits = violations.filter((hit) => hit.file === file && isFixable(hit))
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    for (const line of new Set(hits.map((hit) => hit.line))) {
      for (const hit of hits.filter((one) => one.line === line).sort((a, b) => b.start - a.start)) {
        const tail = lines[line - 1].slice(hit.start + hit.text.length)
        lines[line - 1] = lines[line - 1].slice(0, hit.start) + hit.fix + tail
      }
    }
    writeFileSync(join(REPO_ROOT, file), lines.join('\n'))
    changed.push({ file, replacements: hits.length })
  }
  return changed
}

function printReport({ violations, allowed, files, skipped }) {
  const pick = (want) => violations.filter((hit) => isFixable(hit) === want)
  const buckets = [
    ['FIXABLE', pick(true)],
    ['REPORT-ONLY', pick(false)]
  ]
  const tail = `${allowed.length} allowlisted (${files} files scanned, ${skipped} skipped)`
  const head = `identity-sweep: ${buckets[0][1].length} fixable, ${buckets[1][1].length} report-only, ${tail}`
  const line = (h) => `    [${h.id}] ${h.file}:${h.line}  ${h.text}${h.fix ? ` -> ${h.fix}` : ''}`
  const readme = (hits) => RULES.filter(([id]) => hits.some((h) => h.id === id))
  const titles = (hits) => readme(hits).map(([id]) => `  ${id}${WHY[id] ? ` — ${WHY[id]}` : ''}`)
  const groups = buckets.filter(([, hits]) => hits.length > 0)
  const body = groups.flatMap(([label, hits]) => [`\n${label}`, ...titles(hits), ...hits.map(line)])
  process.stdout.write(`${head}\n${body.join('\n')}\n`)
}

const USAGE = `Scans ${SCAN_ROOTS.join(', ')} for names this fork renamed to "Orca NP".

  node local/sync/identity-sweep.mjs [--json | --fix | --help]

Buckets
  fixable  a mechanical literal (path, executable name, test expectation, config value, NSIS
           define). --fix rewrites these, prints every file it changed, safe to run twice.
  why      a real violation awaiting a decision: persisted user paths, on-disk state, the bare
           \`orca\`, legacy names. Never rewritten. Both buckets fail the gate.

Rules`

function printHelp() {
  const rule = ([id, , template]) => `  ${id}${template ? ` -> ${template}` : ' [report-only]'}`
  const rules = RULES.map((r) => `${rule(r)}${WHY[r[0]] ? `\n    ${WHY[r[0]]}` : ''}`)
  const allow = ALLOWLIST.map(([p, why, paths, when]) => {
    const scope = paths ? ` [path: ${paths.source}]` : when ? ` [line: ${when.source}]` : ''
    return `  ${p.source}${scope}\n    ${why}`
  })
  const note = `Not scanned: .git/**, local/**, docs/**, node_modules/**, LOCAL-PATCHES.md, BRANCHES.md`
  const note2 = ` and the upstream-sync runbook, which own the identity patch. Files over ${MAX_BYTES} bytes, and`
  const note3 = ' binary files, are skipped and counted.'
  const body = [USAGE, ...rules, '', 'Allowlist — deliberate, never reported', ...allow, '']
  process.stdout.write(`${body.join('\n')}\n${note}${note2}${note3}\n`)
}

function main() {
  const [flag] = process.argv.slice(2)
  if (flag && !['--json', '--fix', '--help'].includes(flag)) {
    process.stderr.write(`identity-sweep: unknown argument '${flag}' — try --help\n`)
    process.exitCode = 2
    return
  }
  if (flag === '--help') {
    return printHelp()
  }
  if (flag === '--fix') {
    const changed = applyFixes(scan().violations)
    const say = ({ file, replacements }) =>
      `identity-sweep: rewrote ${file} — ${replacements} replacements`
    process.stdout.write(`${changed.map(say).join('\n') || 'identity-sweep: nothing to fix'}\n`)
    return printReport(scan())
  }
  const result = scan()
  const fixable = result.violations.filter(isFixable)
  const reportOnly = result.violations.filter((hit) => !isFixable(hit))
  if (flag === '--json') {
    const brief = (hit) => ({ rule: hit.id, file: hit.file, line: hit.line, text: hit.text })
    const json = { ok: result.violations.length === 0, filesScanned: result.files }
    json.filesSkipped = result.skipped
    json.counts = {
      fixable: fixable.length,
      reportOnly: reportOnly.length,
      allowlisted: result.allowed.length
    }
    json.fixable = fixable.map((hit) => ({ ...brief(hit), to: hit.fix }))
    json.reportOnly = reportOnly.map((hit) => ({ ...brief(hit), why: WHY[hit.id] }))
    json.allowlisted = result.allowed.map((hit) => ({ ...brief(hit), why: hit.allowed }))
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`)
  } else {
    printReport(result)
  }
  // Why exitCode and not exit(): a large --json report must not be truncated on a pipe.
  process.exitCode = result.violations.length === 0 ? 0 : 1
}

main()
