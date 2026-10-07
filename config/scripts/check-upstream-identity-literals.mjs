import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet for this fork's own identity in tests.
//
// This fork ships beside an official Orca install with its own GitHub repository, its own bundle
// id, its own home directory and its own CLI name (`src/shared/app-directory-names.ts`). Upstream
// tests sometimes assert upstream's identity, which is correct upstream and wrong here: the
// agent-state-rules feed tests asserted `github.com/stablyai/orca/releases/...` while the product
// correctly serves `github.com/nplez1/orca/...`, so CI failed on the fork's own deliberate change
// and said nothing about the change under test.
//
// The rule is one position, not "no upstream references". Naming upstream as fixture data is
// legitimate and common — repo labels, PR URLs, project ids all do it — so a rule that flagged
// those would trade one class of false failure for another. A line that needs upstream's feed on
// purpose carries a marker:
//
//   // upstream-identity-ok: asserts the upgrade path away from upstream's feed
//
// Why not also the CLI's command name: it has the same failure mode, but its literals here are
// ambiguous — `config/scripts/orca-dev.mjs` is a real file, two e2e specs type
// `orca-dev orchestration check` into a PTY, and a daemon fixture lists legacy `orca`/`orca-dev`
// directories to clean up. Policing those without being able to run them is how a ratchet becomes
// noise.
const UPSTREAM_FEED_FRAGMENT = 'stablyai/orca/releases'
const MARKER = 'upstream-identity-ok'
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
// Why suffix patterns: git filters at the source, so this never buffers the repository's whole
// tracked-file list (30k paths overflow execFileSync's default maxBuffer).
// Why only product tests: in `src/`, the update feed and the agent-state-rules URL are derived
// from `MAIN_RELEASE_REPO` (`src/shared/release-channel.ts`), so a hardcoded upstream feed there is
// stale by construction. Two surfaces name upstream on purpose and are out of scope:
//   - `config/scripts/*release*.test.mjs` — the release pipeline reads upstream's latest stable
//     release to compute the next version, so it names both repositories.
//   - `mobile/src/app-update/**` — the mobile APK source deliberately queries upstream's releases
//     (`github-release-update-source.ts`). Whether Orca NP should publish its own APKs is a product
//     decision, not a test-staleness one, so it is reported rather than policed.
const POLICED_ROOTS = ['src']
const TEST_PATHSPECS = [
  '*.test.ts',
  '*.test.tsx',
  '*.test.mts',
  '*.test.cts',
  '*.test.js',
  '*.test.jsx',
  '*.test.mjs',
  '*.test.cjs',
  '*.spec.ts',
  '*.spec.tsx'
]

export function isTestFile(relativePath) {
  return TEST_FILE_RE.test(relativePath)
}

/** Whether this test file is one whose product derives the release feed from the fork's constant.
 *
 *  Why a predicate rather than git pathspecs: git ORs pathspecs, so `-- src '*.test.ts'` matches
 *  every test file in the repository *plus* everything under `src/`. */
export function isPolicedTestPath(relativePath) {
  return (
    isTestFile(relativePath) && POLICED_ROOTS.some((root) => relativePath.startsWith(`${root}/`))
  )
}

/** The offending lines of one file's text. Pure, so the rule is testable without disk. */
export function findUpstreamIdentityLines(sourceText) {
  const findings = []
  const lines = sourceText.split('\n')
  lines.forEach((line, index) => {
    if (!line.includes(UPSTREAM_FEED_FRAGMENT)) {
      return
    }
    // A marker on the line itself or the one above only covers the line it explains.
    const previous = index > 0 ? lines[index - 1] : ''
    if (line.includes(MARKER) || previous.includes(MARKER)) {
      return
    }
    findings.push({ line: index + 1, text: line.trim() })
  })
  return findings
}

function trackedTestFiles(root) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ...TEST_PATHSPECS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  return tracked.split('\0').filter((entry) => entry.length > 0 && isPolicedTestPath(entry))
}

export function collectUpstreamIdentityFindings(root = process.cwd()) {
  const findings = []
  for (const relativePath of trackedTestFiles(root)) {
    let sourceText
    try {
      sourceText = fs.readFileSync(path.join(root, relativePath), 'utf8')
    } catch {
      // A tracked file that cannot be read is not this check's business.
      continue
    }
    for (const finding of findUpstreamIdentityLines(sourceText)) {
      findings.push({ file: relativePath, ...finding })
    }
  }
  return findings
}

export function main(root = process.cwd()) {
  const findings = collectUpstreamIdentityFindings(root)
  if (findings.length === 0) {
    console.log('Upstream release feed in tests: 0 finding(s) in tracked test files.')
    return 0
  }
  console.error(
    `Found ${findings.length} test assertion(s) pointing the release feed at upstream ` +
      `(${UPSTREAM_FEED_FRAGMENT}).\n` +
      `This fork serves its own feed; assert against the fork's constant, or mark a\n` +
      `deliberate upstream reference with \`${MARKER}: <reason>\`.\n`
  )
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.text}`)
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
