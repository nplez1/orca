import { describe, expect, it } from 'vitest'
import { allUses, readWorkflow, usesLines } from './workflow-file.mjs'

/**
 * The fork's own workflows, which this fork owns rather than syncs. Upstream's files are tag-pinned
 * throughout and changing them would diverge on every sync — the release-adjacent lanes are where a
 * moved tag reaches a signing secret.
 */
const FORK_WORKFLOWS = [
  '.github/workflows/fork-release.yml',
  '.github/workflows/fork-main-tests.yml',
  '.github/workflows/fork-upstream-tags.yml',
  '.github/workflows/fork-ci-health.yml',
  '.github/workflows/fork-pr-gates.yml'
]

const PINNED = /^[^@\s]+@[0-9a-f]{40} # v\d+(?:\.\d+){1,2}$/

describe('fork workflow action pins', () => {
  for (const path of FORK_WORKFLOWS) {
    it(`pins every third-party action in ${path} to a SHA and names its tag`, () => {
      const unpinned = usesLines(path).filter((uses) => !PINNED.test(uses))

      expect(unpinned, `${path}: ${unpinned.join(' | ')}`).toEqual([])
    })
  }

  it('has pins at all, so the check is not passing an empty list', () => {
    expect(allUses(readWorkflow('.github/workflows/fork-release.yml')).length).toBeGreaterThan(0)
    expect(usesLines('.github/workflows/fork-release.yml').length).toBeGreaterThan(0)
  })

  it('pins the checkout the tag mirror authenticates with', () => {
    const [checkout] = usesLines('.github/workflows/fork-upstream-tags.yml')

    expect(checkout).toMatch(/^actions\/checkout@[0-9a-f]{40} # v6\.1\.0$/)
  })
})
