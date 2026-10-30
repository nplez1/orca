import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the Jira and board surface — where the fork introduced ad-hoc pixel type
 * sizes — against the documented scale (STYLEGUIDE.md § Typography): 10px is
 * `text-3xs`, 11px `text-2xs`, 12px `text-xs`, 14px `text-sm`. 13px stays arbitrary
 * because the scale has no token for the dense-row size it names.
 */
const SIZES_WITH_A_TOKEN = [10, 11, 12, 14]
const COMPONENTS_ROOT = join(import.meta.dirname)

function jiraSurfaceFiles(directory = COMPONENTS_ROOT, insideJiraFolder = false): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return jiraSurfaceFiles(path, insideJiraFolder || /^jira$/i.test(entry.name))
    }
    const isSource = entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')
    const covered = isSource && (insideJiraFolder || /jira/i.test(entry.name))
    // Named by the audit as one of the worst offenders, outside the Jira folder.
    const namedByTheIssue = entry.name === 'session-summary-ledger-view.tsx'
    return covered || namedByTheIssue ? [path] : []
  })
}

describe('Jira surface type scale', () => {
  it('covers the files the audit named', () => {
    const covered = jiraSurfaceFiles().map((path) => path.slice(COMPONENTS_ROOT.length + 1))
    expect(covered).toEqual(
      expect.arrayContaining([
        'task-page-jira-issue-row.tsx',
        join('task-page', 'jira', 'BoardColumns.tsx'),
        join('right-sidebar', 'JiraLinkedIssuePane.tsx'),
        join('activity', 'session-summary-ledger-view.tsx')
      ])
    )
  })

  it('uses the documented token wherever the scale has one', () => {
    const offenders: string[] = []
    for (const path of jiraSurfaceFiles()) {
      for (const match of readFileSync(path, 'utf8').matchAll(/text-\[(\d+)px\]/g)) {
        if (SIZES_WITH_A_TOKEN.includes(Number(match[1]))) {
          offenders.push(`${path.slice(COMPONENTS_ROOT.length + 1)}: ${match[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
