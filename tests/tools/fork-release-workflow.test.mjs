import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Why the file text and not a YAML parser: this pins the two guards the release depends on, and a
// parse-and-inspect test would pass just as happily with the checks deleted from a step nothing runs.
const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/fork-release.yml', import.meta.url),
  'utf8'
)

const jobBlock = (name) => {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`)
  expect(start, `missing job: ${name}`).toBeGreaterThan(-1)
  const rest = WORKFLOW.slice(start + 1)
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

it('refuses a dispatch from anywhere but the fork release line', () => {
  // `workflow_dispatch` accepts any ref, and the release this publishes is the update feed every
  // installed build reads — so the ref is the first thing that has to be checked.
  const preflight = jobBlock('release-ref')
  expect(preflight).toContain('refs/heads/nplez1/main')
  expect(preflight).toMatch(/if \[ "\$GITHUB_REF" != "refs\/heads\/nplez1\/main" \]/)
  expect(preflight).toContain('exit 1')
})

it('refuses a tag that already points at another commit', () => {
  // The old shape printed "uploading into it" without comparing, so re-dispatching from a newer
  // commit replaced the assets while the tag and notes still named the old revision.
  const preflight = jobBlock('release-ref')
  expect(preflight).toContain('targetCommitish')
  expect(preflight).toContain('${GITHUB_SHA,,}')
  expect(preflight).toMatch(/already exists at \$target, not \$GITHUB_SHA/)
})

it('runs both guards before any platform builds', () => {
  // A guard that every leg can start ahead of is not a guard: the artifacts are built and uploaded
  // by the legs themselves.
  expect(jobBlock('macos')).toMatch(/\n {4}needs: release-ref\n/)
  expect(jobBlock('windows')).toMatch(/\n {4}needs: macos\n/)
  expect(jobBlock('linux')).toMatch(/\n {4}needs: windows\n/)
  expect(WORKFLOW.indexOf('release-ref:')).toBeLessThan(WORKFLOW.indexOf('macos:'))
})
