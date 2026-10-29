// Pre-merge rename forecast: which fork-only references will point at nothing once upstream's
// renames and deletions (old-base..new-base) land. Pure: git output and file lists in, report out.
//
// Only lines the fork added (old-base..tip) are scanned, because upstream rewrites its own callers;
// the fork's are the ones a merge leaves behind. A reference is resolved twice — at the tip, and
// again from where the importer will live after the merge — so a directory upstream moved with the
// importer inside it is not a finding, and an importer moved away from its target is.
import path from 'node:path'
import { parseSource, ts } from './ts-source.mjs'

const RESOLVE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.d.ts'
]
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }
// The repo's renderer aliases, from config/tsconfig.web.json. `@renderer/` is the older spelling and is
// still used by config scripts and tests, so a sweep that only knew `@/` would skip those references
// entirely.
const RENDERER_ALIASES = [
  { prefix: '@/', root: 'src/renderer/src/' },
  { prefix: '@renderer/', root: 'src/renderer/src/' }
]
const MOCK_CALL =
  /^(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual)$/
const PATHISH = /^[\w@.][\w@.+-]*(?:\/[\w@.+[\]-]+)+\/?$/

function unquote(name) {
  if (!name.startsWith('"')) {
    return name
  }
  try {
    return JSON.parse(name)
  } catch {
    return name
  }
}

/** `git diff -z --name-status -M --diff-filter=RD` -> renames (from -> to) and deletions. */
export function parseNameStatus(text) {
  const fields = text.split('\0').filter((field) => field !== '')
  const renames = new Map()
  const deletions = new Set()
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index]
    if (code.startsWith('R')) {
      renames.set(fields[index + 1], fields[index + 2])
      index += 2
    } else if (code.startsWith('D')) {
      deletions.add(fields[index + 1])
      index += 1
    } else if (code.startsWith('C')) {
      index += 2
    } else {
      index += 1
    }
  }
  return { renames, deletions }
}

/** `git diff -U0` -> Map(file -> Set of added line numbers in the new file). */
export function addedLines(diff) {
  const byFile = new Map()
  let current = null
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      const name = unquote(row.slice(4))
      current = name === '/dev/null' ? null : name.replace(/^b\//, '')
      if (current !== null && !byFile.has(current)) {
        byFile.set(current, new Set())
      }
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row)
    if (hunk && current !== null) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let line = start; line < start + count; line += 1) {
        byFile.get(current).add(line)
      }
    }
  }
  return byFile
}

function referenceKind(node) {
  const parent = node.parent
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return 'import'
  }
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) {
    return 'import'
  }
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression
    if (callee.kind === ts.SyntaxKind.ImportKeyword || callee.getText() === 'require') {
      return 'import'
    }
    if (MOCK_CALL.test(callee.getText())) {
      return 'mock'
    }
  }
  return 'string'
}

/** String literals on the given lines that name a module or a path, with what they are used as. */
export function referencesIn(file, text, lines) {
  const parsed = parseSource(file, text)
  if (parsed === null || lines.size === 0) {
    return []
  }
  const { sf } = parsed
  const found = []
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const kind = referenceKind(node)
      const spec = node.text
      if (lines.has(line) && (kind !== 'string' || PATHISH.test(spec))) {
        found.push({ spec, kind, line })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** A file set that also answers "is this a directory" and "which top-level dirs exist". */
export function fileSet(files) {
  const all = new Set(files)
  const dirs = new Set()
  for (const file of all) {
    let dir = path.posix.dirname(file)
    while (dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  return { files: all, dirs, top: new Set([...dirs].filter((dir) => !dir.includes('/'))) }
}

function basePath(importer, spec, kind, set) {
  const clean = spec.replace(/[?#].*$/, '').replace(/\/$/, '')
  if (clean.startsWith('./') || clean.startsWith('../')) {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean))
    return joined.startsWith('..') ? null : joined
  }
  const alias = RENDERER_ALIASES.find(({ prefix }) => clean.startsWith(prefix))
  if (alias) {
    return alias.root + clean.slice(alias.prefix.length)
  }
  const repoRelative = clean.replace(/^\.\//, '')
  return kind === 'string' && set.top.has(repoRelative.split('/')[0]) ? repoRelative : null
}

/**
 * Whether `spec` names a path inside this repository at all, as opposed to a package. Split out so a
 * caller can tell "this resolves to nothing" from "this was never a repo path".
 */
export function namesRepoPath(importer, spec, kind, set) {
  return basePath(importer, spec, kind, set) !== null
}

/** What `spec` names from `importer` in `set`: a file, a directory, or null (a package, or nothing). */
export function resolveRef(importer, spec, kind, set) {
  const target = basePath(importer, spec, kind, set)
  if (target === null) {
    return null
  }
  const ext = path.posix.extname(target)
  const swapped = (JS_TO_TS[ext] ?? []).map((to) => target.slice(0, -ext.length) + to)
  // A plain string is literal: nothing applies module resolution to it, so it names a file or a dir.
  const candidates =
    kind === 'string'
      ? [target]
      : [
          target,
          ...swapped,
          ...RESOLVE_EXTS.map((suffix) => target + suffix),
          ...RESOLVE_EXTS.map((suffix) => `${target}/index${suffix}`)
        ]
  const hit = candidates.find((candidate) => set.files.has(candidate))
  if (hit) {
    return { path: hit, dir: false }
  }
  return set.dirs.has(target) ? { path: target, dir: true } : null
}

/** Where a directory goes: unchanged if it survives, the one common new home if all of it moved. */
function movedDir(dir, oldBaseFiles, after, post) {
  if (post.dirs.has(dir)) {
    return dir
  }
  const homes = new Set()
  for (const file of oldBaseFiles) {
    if (!file.startsWith(`${dir}/`)) {
      continue
    }
    const moved = after(file)
    const rest = file.slice(dir.length + 1)
    if (moved === null) {
      continue
    }
    if (!moved.endsWith(`/${rest}`)) {
      return null
    }
    homes.add(moved.slice(0, moved.length - rest.length - 1))
  }
  return homes.size === 1 ? [...homes][0] : null
}

/** The specifier the reference needs after the merge, in the style it was written in. */
export function suggestSpecifier(importer, target, spec) {
  if (target === null) {
    return null
  }
  const bare = path.posix.extname(spec.replace(/[?#].*$/, '')) === ''
  const shown = bare
    ? target.replace(/\.d\.ts$|\.[cm]?[jt]sx?$|\.json$/, '').replace(/\/index$/, '')
    : target
  const alias = RENDERER_ALIASES.find(
    ({ prefix, root }) => spec.startsWith(prefix) && shown.startsWith(root)
  )
  if (alias) {
    return alias.prefix + shown.slice(alias.root.length)
  }
  if (!spec.startsWith('.')) {
    return shown
  }
  const relative = path.posix.relative(path.posix.dirname(importer), shown)
  return relative.startsWith('.') ? relative : `./${relative}`
}

/**
 * `references` is [{ file, spec, kind, line }] from the fork's added lines at the tip.
 * Returns `{ missingRefs: [{ from, to, kinds, referencedBy: ['file:line'], suggested }], counts }`;
 * `to` is null when upstream deleted the target or scattered a directory across several homes.
 */
export function forecastRenames({
  renames,
  deletions,
  oldBaseFiles,
  tipFiles,
  newBaseFiles,
  references
}) {
  const oldBase = new Set(oldBaseFiles)
  const tip = fileSet(tipFiles)
  const post = fileSet([...newBaseFiles, ...tipFiles.filter((file) => !oldBase.has(file))])
  const after = (file) => renames.get(file) ?? (deletions.has(file) ? null : file)
  const grouped = new Map()
  for (const ref of references) {
    const target = resolveRef(ref.file, ref.spec, ref.kind, tip)
    const importer = after(ref.file)
    if (target === null || importer === null) {
      continue
    }
    const moved = target.dir ? movedDir(target.path, oldBaseFiles, after, post) : after(target.path)
    const again = resolveRef(importer, ref.spec, ref.kind, post)
    if (moved !== null && again?.path === moved && again.dir === target.dir) {
      continue
    }
    const key = `${target.path}\0${moved}`
    const entry = grouped.get(key) ?? {
      from: target.path,
      to: moved,
      kinds: [],
      referencedBy: [],
      suggested: []
    }
    entry.kinds = [...new Set([...entry.kinds, ref.kind])]
    entry.referencedBy.push(`${ref.file}:${ref.line}`)
    const suggestion = suggestSpecifier(importer, moved, ref.spec)
    if (suggestion !== null && !entry.suggested.includes(suggestion)) {
      entry.suggested.push(suggestion)
    }
    grouped.set(key, entry)
  }
  const missingRefs = [...grouped.values()].sort((a, b) => (a.from < b.from ? -1 : 1))
  const files = new Set(
    missingRefs.flatMap((ref) => ref.referencedBy.map((at) => at.replace(/:\d+$/, '')))
  )
  const modules = new Set(missingRefs.map((ref) => path.posix.dirname(ref.from)))
  return {
    missingRefs,
    counts: {
      renames: renames.size,
      deletions: deletions.size,
      scannedReferences: references.length,
      missingRefs: missingRefs.length,
      referencingFiles: files.size,
      modules: modules.size
    }
  }
}

export function renderForecast(report) {
  const { counts } = report
  const rows = [
    `rename forecast ${report.range}: ${counts.missingRefs} target(s) referenced from ${counts.referencingFiles} fork file(s) across ${counts.modules} module(s) will not resolve after the merge`,
    `  (${counts.renames} upstream rename(s), ${counts.deletions} deletion(s); ${counts.scannedReferences} fork-added reference(s) scanned)`
  ]
  for (const ref of report.missingRefs) {
    rows.push(
      `  ${ref.from} -> ${ref.to ?? '(deleted, or scattered across several directories)'}  [${ref.kinds.join(', ')}]`
    )
    for (const at of ref.referencedBy.slice(0, 10)) {
      rows.push(`      ${at}`)
    }
    if (ref.referencedBy.length > 10) {
      rows.push(`      ... ${ref.referencedBy.length - 10} more`)
    }
    if (ref.suggested.length > 0) {
      rows.push(`      becomes: ${ref.suggested.join(' | ')}`)
    }
  }
  return rows.join('\n')
}
