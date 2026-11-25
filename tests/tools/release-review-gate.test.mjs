import { describe, expect, it } from 'vitest'
import { REVIEWER } from '../../local/pr-body-claims.mjs'
import { validateManifest, reviewNeutralOnly } from '../../local/release-review-gate.mjs'

const REVISION = '0e24285da2b3fa18b4abc7ae84dbb959f399cb97'

/**
 * The two tiers a release now needs, in their smallest passing shape: one swept slice that raised nothing
 * and one adjudication packet that judged nothing. `release-review-tiers.test.mjs` pins the rules that
 * make an unanswered sweep or an unjudged finding refuse.
 */
const clearedTiers = () => ({
  sweep: {
    reviewer: { name: 'cheap-tier' },
    slices: [{ id: 'S', verdict: 'reported', findings: [] }]
  },
  adjudication: {
    reviewer: { ...REVIEWER },
    slices: [{ id: 'adj-1', verdict: 'reported' }],
    judged: []
  }
})

const manifest = (slices, extra = {}) => ({
  revision: REVISION,
  reviewer: { ...REVIEWER },
  slices,
  ...clearedTiers(),
  waiver: null,
  ...extra
})

const reported = (id, unresolved = 0) => ({ id, verdict: 'reported', unresolved })

/**
 * The failure this gate exists for: on 2026-11-10 a review spawned six slices, received findings from
 * three, reported "done", and the release was dispatched on a third of its review. A slice that was
 * dispatched and never answered has to refuse the release, because that is the exact shape that got
 * through — so it is pinned here rather than left to the reviewer's summary.
 */
describe('release review gate', () => {
  it('passes a manifest whose every slice reported', () => {
    expect(
      validateManifest(manifest([reported('A'), reported('B')]), { revision: REVISION })
    ).toEqual([])
  })

  it('refuses a slice that was dispatched and never reported', () => {
    const problems = validateManifest(
      manifest([
        reported('A'),
        { id: 'B', verdict: 'no-report' },
        { id: 'D', verdict: 'no-report' }
      ]),
      { revision: REVISION }
    )
    expect(problems).toEqual([
      'slice B was dispatched and never reported (verdict "no-report")',
      'slice D was dispatched and never reported (verdict "no-report")'
    ])
  })

  // Why an absent verdict is not the same as a silent slice: `no-report` says the review planned the
  // slice and heard nothing back, while a missing field says nobody recorded what happened at all.
  it('refuses a slice with no verdict at all', () => {
    expect(
      validateManifest(manifest([reported('A'), { id: 'B' }]), { revision: REVISION })
    ).toEqual(['slice B has no verdict recorded (got null)'])
  })

  it('refuses unresolved blocking findings', () => {
    expect(validateManifest(manifest([reported('A', 2)]), { revision: REVISION })).toEqual([
      'slice A carries 2 unresolved blocking finding(s)'
    ])
  })

  it('refuses a review by anyone but the configured reviewer', () => {
    const problems = validateManifest(
      manifest([reported('A')], { reviewer: { ...REVIEWER, thinking: 'medium' } }),
      { revision: REVISION }
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('thinking differ')
  })

  it('refuses a manifest that is for another revision', () => {
    const problems = validateManifest(manifest([reported('A')]), { revision: 'f'.repeat(40) })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('not the revision being released')
  })

  it('refuses a review with no slice list, which cannot be shown to be complete', () => {
    expect(validateManifest(manifest([]), { revision: REVISION })).toEqual([
      'no slices recorded: a review with no slice list cannot be shown to be complete'
    ])
  })

  // Why: the manifest names a revision, so committing it moves HEAD past what it records — a fixed
  // point is impossible. The PR gate's rule answers it (a later commit voids the review only if it
  // changes code), and these pin the boundary, because widening it would let a release stand on a
  // review of code it no longer matches.
  it('lets docs and review records follow the reviewed revision', () => {
    expect(reviewNeutralOnly(['local/sync/release-review/abc.json', 'RELEASE-RUNBOOK.md'])).toBe(
      true
    )
  })

  it('voids the review when any code changed after it', () => {
    expect(reviewNeutralOnly(['local/sync/release-review/abc.json', 'src/main/a.ts'])).toBe(false)
    expect(reviewNeutralOnly(['src/renderer/src/x.tsx'])).toBe(false)
  })

  // Why a gate file is not a doc: `local/` holds the gates themselves, so a change there is a change
  // to how releases are judged, not a record of one.
  it('does not treat the gate scripts themselves as review-neutral', () => {
    expect(reviewNeutralOnly(['local/release-review-gate.mjs'])).toBe(false)
  })

  // Why these three: each is `.md`, and each is published or executed, so a rule that reads only the
  // suffix lets a change to one ship behind a review of code it no longer matches.
  it('does not treat published or executed markdown as review-neutral', () => {
    expect(reviewNeutralOnly(['.github/fork-release-notes.md'])).toBe(false)
    expect(reviewNeutralOnly(['.agents/skills/electron/SKILL.md'])).toBe(false)
    expect(reviewNeutralOnly(['resources/native-chat-visuals/skills/a/SKILL.md'])).toBe(false)
  })

  // Why: `docs/site` is a Next app, so the `docs/` prefix is not a claim about documentation.
  it('exempts documentation markdown under docs, and nothing else there', () => {
    expect(reviewNeutralOnly(['docs/reference/host-settings-replication.md'])).toBe(true)
    expect(reviewNeutralOnly(['docs/site/next.config.ts'])).toBe(false)
  })

  it('refuses a missing manifest outright', () => {
    expect(validateManifest(null, { revision: REVISION })).toEqual([
      'no manifest: the review of this revision is not recorded'
    ])
  })

  // Why a waiver may clear the slices and not the reviewer: the reviewer is a fact about which review
  // happened, and a waiver cannot make a review be a different review.
  it('lets a recorded waiver clear silent slices but never the reviewer', () => {
    const waived = validateManifest(
      manifest([{ id: 'A', verdict: 'no-report' }], { waiver: { reason: 'ran out of budget' } }),
      { revision: REVISION }
    )
    expect(waived).toEqual([])

    const wrongReviewer = validateManifest(
      manifest([{ id: 'A', verdict: 'no-report' }], {
        waiver: { reason: 'ran out of budget' },
        reviewer: { ...REVIEWER, alias: 'sonnet' }
      }),
      { revision: REVISION }
    )
    expect(wrongReviewer).toHaveLength(1)
    expect(wrongReviewer[0]).toContain('not')
  })

  // Why: a waiver with no reason is the thing the gate is supposed to stop — a release that says
  // nothing about why its review was skipped.
  it('does not treat an empty waiver as a waiver', () => {
    const problems = validateManifest(
      manifest([{ id: 'A', verdict: 'no-report' }], { waiver: { reason: '   ' } }),
      { revision: REVISION }
    )
    expect(problems).toEqual(['slice A was dispatched and never reported (verdict "no-report")'])
  })
})
