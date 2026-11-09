// The shard verdict's other input: the files the shard was assigned. A report only proves what ran,
// so a worker that died takes its file out of it — and the report over whatever survived reads green.
import { writeFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { readShardAssignment } from '../../local/check-unit-shard-verdict.mjs'
import {
  cleanupTempDirs,
  decide,
  log,
  report,
  run,
  runRaw,
  tempDir
} from './unit-shard-verdict-harness.mjs'

afterEach(cleanupTempDirs)

it('fails when an assigned file is missing from the report', () => {
  const verdict = decide({
    reportText: report({ totalTests: 1, passing: [['src/a.test.ts', 'runs']] }),
    assignedFiles: ['src/a.test.ts', 'src/b.test.ts']
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'the report does not name 1 file(s) the lane should have run: src/b.test.ts'
  ])
})

it('passes when the report names every assigned file', () => {
  const verdict = decide({
    reportText: report({
      passing: [
        ['src/a.test.ts', 'runs'],
        ['src/b.test.ts', 'runs']
      ]
    }),
    assignedFiles: ['src/a.test.ts', 'src/b.test.ts']
  })

  expect(verdict).toEqual({ ok: true, tolerated: [], absorbed: [], prunable: [], problems: [] })
})

it('matches an absolute CI report path against a repo-relative assignment', () => {
  // Why not this checkout's own root: the point is a report produced in another checkout — the
  // verdict has to judge a downloaded artifact, whose paths are no path on the machine reading it.
  const verdict = decide({
    reportText: report({ passing: [['/home/runner/work/orca/orca/src/a.test.ts', 'runs']] }),
    assignedFiles: ['src/a.test.ts']
  })

  expect(verdict.ok).toBe(true)
})

it('does not pair a sibling directory with the assigned file', () => {
  const verdict = decide({
    reportText: report({ passing: [['/home/runner/work/orca/orca/src/other/a.test.ts', 'runs']] }),
    assignedFiles: ['src/a.test.ts']
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'the report does not name 1 file(s) the lane should have run: src/a.test.ts',
    'the report names 1 file(s) this shard was not assigned, so the assignment does not describe this run: /home/runner/work/orca/orca/src/other/a.test.ts'
  ])
})

it('fails when the report names a file the shard was not assigned', () => {
  const verdict = decide({
    reportText: report({
      passing: [
        ['src/a.test.ts', 'runs'],
        ['src/other.test.ts', 'runs']
      ]
    }),
    assignedFiles: ['src/a.test.ts']
  })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toEqual([
    'the report names 1 file(s) this shard was not assigned, so the assignment does not describe this run: src/other.test.ts'
  ])
})

it('fails when the assignment gives the shard no files', () => {
  const verdict = decide({ assignedFiles: [] })

  expect(verdict.ok).toBe(false)
  expect(verdict.problems).toContain(
    'the shard assignment gives this shard no files, so nothing proves what it should have run'
  )
})

it('reads the selected shard out of the sequencer manifest and rejects a stale one', () => {
  const assignment = {
    runId: '1',
    runAttempt: '1',
    selectedShard: 2,
    shards: [{ files: ['src/a.test.ts'] }, { files: ['src/b.test.ts'] }]
  }
  const text = JSON.stringify(assignment)

  expect(readShardAssignment(text, { runId: '1', runAttempt: '1' })).toEqual({
    files: ['src/b.test.ts']
  })
  expect(readShardAssignment(text, { runId: '2', runAttempt: '1' }).problem).toContain(
    'from runId 1, not this one (2)'
  )
  expect(readShardAssignment(text, { runId: '1', runAttempt: '2' }).problem).toContain(
    'from runAttempt 1, not this one (2)'
  )
  expect(readShardAssignment('not json').problem).toContain('unreadable')
  expect(readShardAssignment(JSON.stringify({ shards: [] })).problem).toContain('holds no shards')
  expect(
    readShardAssignment(JSON.stringify({ shards: [{ files: ['a'] }], selectedShard: 3 })).problem
  ).toContain('which is not one of its 1 shard(s)')
  expect(
    readShardAssignment(JSON.stringify({ shards: [{ files: 'a' }], selectedShard: 1 })).problem
  ).toContain('no usable file list')
})

it('exits zero when the assignment accounts for every file in the report', () => {
  const result = run(
    report({ totalTests: 2, passing: [['src/a.test.ts', 'runs']] }),
    log(),
    'success',
    [],
    { assignment: { selectedShard: 1, shards: [{ files: ['src/a.test.ts'] }] } }
  )

  expect(result.status).toBe(0)
})

it('exits non-zero when an assigned file is absent from the report', () => {
  const result = run(
    report({ totalTests: 2, passing: [['src/a.test.ts', 'runs']] }),
    log(),
    'success',
    [],
    { assignment: { selectedShard: 1, shards: [{ files: ['src/a.test.ts', 'src/b.test.ts'] }] } }
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain(
    '::error::unit shard: the report does not name 1 file(s) the lane should have run: src/b.test.ts'
  )
})

it('rejects an assignment written by another run of the same workflow', () => {
  const result = run(
    report({ totalTests: 2, passing: [['src/a.test.ts', 'runs']] }),
    log(),
    'success',
    [],
    {
      assignment: {
        runId: '111',
        runAttempt: '1',
        selectedShard: 1,
        shards: [{ files: ['src/a.test.ts'] }]
      },
      env: { GITHUB_RUN_ID: '222', GITHUB_RUN_ATTEMPT: '1' }
    }
  )

  expect(result.status).toBe(1)
  expect(result.stdout).toContain('the shard assignment is from runId 111, not this one (222)')
})

it('exits non-zero when the assignment cannot be read or does not describe a shard', () => {
  const malformed = run(report(), log(), 'success', [], { assignment: 'not json' })

  expect(malformed.status).toBe(1)
  expect(malformed.stdout).toContain('::error::unit shard: the shard assignment is unreadable')

  const dir = tempDir()
  const reportPath = `${dir}/report.json`
  const logPath = `${dir}/shard.log`
  writeFileSync(reportPath, report())
  writeFileSync(logPath, log())
  const absent = runRaw([
    reportPath,
    logPath,
    'success',
    '--assignment',
    `${dir}/missing-assignment.json`
  ])

  expect(absent.status).toBe(1)
  expect(absent.stdout).toContain('::error::unit shard: cannot read the shard assignment')
})

it('treats --assignment without a path as a usage error, not as no assignment', () => {
  const result = runRaw(['report.json', 'shard.log', 'failure', '--assignment'])

  expect(result.status).toBe(2)
  expect(result.stdout).toContain('--assignment needs a path')
})
