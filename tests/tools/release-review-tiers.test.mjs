import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REVIEWER } from '../../local/pr-body-claims.mjs'
import { validateManifest } from '../../local/release-review-gate.mjs'
import { prepareAdjudication } from '../../local/review-packets/adjudicate.mjs'
import { prepareSync } from '../../local/review-packets/packet.mjs'
import {
  prepareSweep,
  readSweepReport,
  recordSweep,
  sweepDirOf
} from '../../local/review-packets/sweep.mjs'
import { tempGitRepo } from '../../local/sync/lib/temp-git-repo.mjs'

// The two tiers the release review runs in: a fine sweep that finds, and REVIEWER's adjudication that
// judges every finding it raised. `release-review-packets.test.mjs` covers each packet and the runner.
const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-review-tiers-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const context = () => ({
  lintSteps: new Set(),
  postSyncRows: new Set(),
  mobilePostinstall: '',
  lintStepReading: () => null
})

const verdictAnswer = (verdict) =>
  `Reasoning.\n\n\`\`\`orca-review-verdict\n${JSON.stringify(verdict)}\n\`\`\`\n`

describe('two tiers', () => {
  /** A merge that resolved several files, so the budget has something to cut differently. */
  function mergedRepo() {
    const repo = tempGitRepo('orca-review-tiers-')
    dirs.push(repo.dir)
    const files = Object.fromEntries(
      ['src/main/a', 'src/main/b', 'src/renderer/src/c', 'src/renderer/src/d'].map((path) => [
        `${path}.ts`,
        'one\n'
      ])
    )
    repo.commit('base', files)
    repo.git('checkout', '-q', '-b', 'side')
    repo.commit(
      'side',
      Object.fromEntries(Object.keys(files).map((path) => [path, `side ${path}\n`]))
    )
    repo.git('checkout', '-q', 'main')
    repo.commit(
      'main',
      Object.fromEntries(Object.keys(files).map((path) => [path, `main ${path}\n`]))
    )
    try {
      repo.git('merge', '-q', 'side')
    } catch {
      // the conflicts are the point
    }
    repo.write(Object.fromEntries(Object.keys(files).map((path) => [path, `resolved ${path}\n`])))
    repo.git('add', '-A')
    repo.git('commit', '-q', '--no-edit')
    return repo
  }

  it('cuts the same diff finer than the reviewer round does, and says it is a sweep', () => {
    const repo = mergedRepo()
    const sync = join(scratch(), 'sync')
    const coarse = prepareSync({ root: repo.dir, merge: 'HEAD', budgetBytes: 100_000, dir: sync })
    const fine = prepareSweep({
      root: repo.dir,
      syncDir: sync,
      merge: 'HEAD',
      budgetBytes: 120,
      context: context()
    })
    expect(fine.packet.kind).toBe('sweep')
    expect(sweepDirOf(sync)).toBe(fine.dir)
    expect(fine.packet.slices.length).toBeGreaterThan(coarse.packet.slices.length)
    expect(fine.packet.reviewed.bytes).toBe(coarse.packet.reviewed.bytes)
    expect(readFileSync(join(fine.dir, 'prompt-A.txt'), 'utf8')).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
  })

  it('records the cheap answers, and holds a malformed one to no-report by name', () => {
    const repo = mergedRepo()
    const sync = join(scratch(), 'sync')
    prepareSync({ root: repo.dir, merge: 'HEAD', budgetBytes: 1_000_000, dir: sync })
    const { dir, packet } = prepareSweep({
      root: repo.dir,
      syncDir: sync,
      merge: 'HEAD',
      budgetBytes: 1_000_000,
      context: context()
    })
    const id = packet.slices[0].id
    const { recorded, problems } = recordSweep({
      dir,
      packet,
      reviewer: 'deepseek-flash',
      answers: [
        { id, answer: verdictAnswer({ findings: [{ severity: 'NIT', file: 'a.ts' }] }) },
        { id: 'ZZ', answer: 'nothing' },
        { id, answer: 'again' }
      ]
    })
    // Why both refused: an id the packet never planned leaves the real slice silent, and a second answer
    // would silently win over the first.
    expect(problems).toEqual(['no slice "ZZ" in this packet', `slice ${id} was answered twice`])
    expect(recorded).toEqual([id])
    expect(readSweepReport(dir, id)).toMatchObject({
      status: 'reported',
      counts: { nits: 1 },
      reviewer: 'deepseek-flash'
    })
    expect(readSweepReport(dir, 'ZZ')).toMatchObject({ status: 'not-run' })

    recordSweep({ dir, packet, answers: [{ id, answer: 'Looks fine.' }] })
    expect(readSweepReport(dir, id).status).toBe('no-report')
  })

  it('judges the sweep findings in packets that carry their resolution hunks', () => {
    const repo = mergedRepo()
    const sync = join(scratch(), 'sync')
    prepareSync({ root: repo.dir, merge: 'HEAD', budgetBytes: 1_000_000, dir: sync })
    const findings = Array.from({ length: 14 }, (_, index) => ({
      id: `S-A-${index + 1}`,
      severity: 'SHOULD-FIX',
      file: 'src/main/a.ts',
      summary: `finding ${index + 1}`,
      why: 'the fork side is gone'
    }))
    const { dir, packet } = prepareAdjudication({
      root: repo.dir,
      syncDir: sync,
      merge: 'HEAD',
      findings
    })
    expect(packet.kind).toBe('adjudicate')
    expect(packet.findings).toHaveLength(14)
    expect(packet.slices.map((slice) => slice.findings.length)).toEqual([12, 2])
    const prompt = readFileSync(join(dir, 'prompt-adj-1.txt'), 'utf8')
    expect(prompt).toContain('[S-A-1] SHOULD-FIX src/main/a.ts: finding 1')
    expect(prompt).not.toContain('[S-A-13]')
    expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
    expect(readFileSync(join(dir, 'adj-1.patch'), 'utf8')).toContain('resolved src/main/a.ts')
    expect(() =>
      prepareAdjudication({ root: repo.dir, syncDir: sync, merge: 'HEAD', findings: [] })
    ).toThrow(/nothing to adjudicate/)
  })
})

describe('the gate requires judgment on every finding', () => {
  const revision = 'r'.repeat(40)
  const manifest = (overrides = {}) => ({
    revision,
    reviewer: REVIEWER,
    slices: [{ id: 'A', verdict: 'reported', blockers: 0, shouldFix: 0, unresolved: 0 }],
    sweep: {
      reviewer: { name: 'deepseek-flash' },
      slices: [
        {
          id: 'A',
          verdict: 'reported',
          findings: [
            { id: 'S-A-1', severity: 'SHOULD-FIX', file: 'a.ts', status: 'open' },
            { id: 'S-A-2', severity: 'NIT', file: 'b.ts', status: 'dismissed (adj-1)' }
          ]
        }
      ]
    },
    adjudication: {
      reviewer: REVIEWER,
      slices: [{ id: 'adj-1', verdict: 'reported' }],
      judged: [
        { id: 'S-A-1', real: false, severity: 'NIT', why: 'covered at HEAD by another suite' },
        { id: 'S-A-2', real: false, severity: 'NIT', why: 'not a defect' }
      ]
    },
    ...overrides
  })

  it('clears when every sweep finding was judged and no confirmed blocker stands', () => {
    expect(validateManifest(manifest(), { revision })).toEqual([])
  })

  it('refuses a review with no sweep at all', () => {
    expect(validateManifest(manifest({ sweep: null }), { revision })).toEqual([
      'no fine sweep recorded: the sweep is what finds the defects a consolidated slice reads past'
    ])
  })

  it('refuses a sweep finding nobody judged, so the cheap tier cannot be advisory', () => {
    const broken = manifest()
    broken.adjudication.judged = [broken.adjudication.judged[1]]
    expect(validateManifest(broken, { revision })).toEqual([
      'sweep finding S-A-1 was never adjudicated'
    ])
  })

  it('refuses a dismissal with no reason and a confirmed blocker left open', () => {
    const dismissed = manifest()
    dismissed.adjudication.judged[0] = { id: 'S-A-1', real: false, severity: 'NIT', why: '  ' }
    expect(validateManifest(dismissed, { revision })).toEqual([
      'sweep finding S-A-1 was dismissed with no reason'
    ])

    const confirmed = manifest()
    confirmed.adjudication.judged[0] = {
      id: 'S-A-1',
      real: true,
      severity: 'SHOULD-FIX',
      why: 'the caller passes one argument for both slots'
    }
    expect(validateManifest(confirmed, { revision })).toEqual([
      'sweep finding S-A-1 is SHOULD-FIX and neither fixed nor dismissed'
    ])
  })

  it('refuses a silent adjudication, and one that rates a real finding without a severity', () => {
    const silent = manifest()
    silent.adjudication.slices = [{ id: 'adj-1', verdict: 'no-report' }]
    expect(validateManifest(silent, { revision })).toEqual([
      'adjudication adj-1 has no report (got "no-report")'
    ])

    const unrated = manifest()
    unrated.adjudication.judged[0] = { id: 'S-A-1', real: true, severity: null, why: 'looks odd' }
    // Why only the first: a finding rated real with no severity has no blocking verdict to hold open,
    // and the missing rating is what the gate must report.
    expect(validateManifest(unrated, { revision })).toEqual([
      'sweep finding S-A-1 was judged real with severity null'
    ])
  })
})
