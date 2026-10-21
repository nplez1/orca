import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ORCA_REPOSITORY,
  ORCA_REPOSITORY_DISPLAY_URL,
  ORCA_REPOSITORY_URL
} from './orca-repository'
import { MAIN_RELEASE_REPO } from './release-channel'

describe('ORCA repository identity', () => {
  // Why: the links this backs and the update feed are one identity. A separate
  // literal is exactly how they ended up sending users to a repository this
  // build does not come from, so the target must stay pinned to the repo the
  // build publishes from.
  it('is the repository this build publishes from', () => {
    expect(ORCA_REPOSITORY).toBe(MAIN_RELEASE_REPO)
  })

  it('is an owner/name slug', () => {
    expect(ORCA_REPOSITORY).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  })

  it('builds the web URL from that slug, with no trailing slash', () => {
    expect(ORCA_REPOSITORY_URL).toBe(`https://github.com/${ORCA_REPOSITORY}`)
    expect(ORCA_REPOSITORY_URL.endsWith('/')).toBe(false)
  })

  it('offers the scheme-less form share text prints', () => {
    expect(ORCA_REPOSITORY_DISPLAY_URL).toBe(`github.com/${ORCA_REPOSITORY}`)
  })
})

/** Every link that names this project's repository, and therefore every place the bug lived. */
const PROJECT_LINK_SURFACES = [
  '../main/github/client/fetch/orca-star.ts',
  '../renderer/src/components/Landing.tsx',
  '../renderer/src/components/StarNagCard.tsx',
  '../renderer/src/components/github-project/ProjectViewStates.tsx',
  '../renderer/src/components/settings/GeneralSupportSection.tsx',
  '../renderer/src/components/sidebar/SidebarFeedbackDialog.tsx',
  '../renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx',
  '../renderer/src/components/star-nag/StarNagToastHost.tsx',
  '../renderer/src/components/stats/ShareUsageButton.tsx',
  '../renderer/src/components/stats/share-card-utils.tsx',
  '../renderer/src/components/terminal-pane/TerminalErrorToast.tsx'
]

/** A repository named in code: `https://github.com/...` or a bare `<owner>/orca` slug.
 *
 *  The bare slug is the one that bit: the star check fed `stablyai/orca` into the API path, and the
 *  test for it spelled that path out in full (`user/starred/stablyai/orca`), so a rule that only
 *  looked for URLs would have missed the file that actually sends the star. The `-` in the lookahead
 *  keeps a module path out — `shared/orca-repository` continues with `-repository`, so it is not a
 *  repo name. Comments are scanned too, which is deliberate: a citation of `nplez1/orca#144` in one
 *  of these files fails, and the list below is an allowlist, so a new surface is only guarded once
 *  it is added to it. */
const NAMED_REPOSITORY_URL = /github\.com\//
const NAMED_REPOSITORY_SLUG = /(?<![\w.-])[\w.-]+\/orca(?![\w./-])/

/** An import of the shared identity, not a comment that mentions it. */
const IDENTITY_IMPORT = /from '(?:\.\.\/)+shared\/orca-repository'/

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('project repository links', () => {
  // Why: every one of these files carried a repository literal of its own, so no assertion in them
  // could have caught it. A link now has to import the constant, and a repository named again in one
  // fails here even if that file's own test was updated with it.
  it.each(PROJECT_LINK_SURFACES)('comes from the shared identity in %s', (relativePath) => {
    const source = readSource(relativePath)
    expect(source).toMatch(IDENTITY_IMPORT)
    expect(source).not.toMatch(NAMED_REPOSITORY_URL)
    expect(source).not.toMatch(NAMED_REPOSITORY_SLUG)
  })

  // Why: the identity module is the last place a literal could hide, and an equality assertion
  // cannot see it — a hardcoded `nplez1/orca` here would equal `MAIN_RELEASE_REPO` in this fork.
  // Only the slug half applies: this module is where the URLs are assembled from the constant.
  it('is derived in its own module, not spelled out', () => {
    const source = readSource('./orca-repository.ts')
    expect(source).toContain('MAIN_RELEASE_REPO')
    expect(source).not.toMatch(NAMED_REPOSITORY_SLUG)
  })
})
