import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allUses, readWorkflow, usesLines } from './workflow-file.mjs'

const WORKFLOW_DIR = new URL('../../.github/workflows/', import.meta.url)

/**
 * The fork's own workflows, discovered rather than listed: a new `fork-*.yml` is covered the moment
 * it lands, which is the failure a fixed list has. Upstream's files are tag-pinned throughout and
 * repinning them is divergence that costs more at the next sync — the release-adjacent lanes are
 * where a moved tag reaches a signing secret.
 */
const FORK_WORKFLOWS = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.startsWith('fork-') && name.endsWith('.yml'))
  .sort()
  .map((name) => `.github/workflows/${name}`)

const PINNED = /^[^@\s]+@[0-9a-f]{40} # v\d+(?:\.\d+){1,2}$/

describe('fork workflow action pins', () => {
  it('finds the fork workflows it means to check', () => {
    expect(FORK_WORKFLOWS.length).toBeGreaterThanOrEqual(6)
    expect(FORK_WORKFLOWS).toContain('.github/workflows/fork-release.yml')
    expect(FORK_WORKFLOWS.every((path) => path.startsWith('.github/workflows/fork-'))).toBe(true)
  })

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
