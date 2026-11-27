import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inlinePatch, prepareDelta, renderTemplate } from '../../local/review-packets/packet.mjs'
import { tempGitRepo } from '../../local/sync/lib/temp-git-repo.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('fences the patch with a run longer than any backtick run inside it', () => {
  const plain = inlinePatch([{ text: '+a\n' }, { text: '-b' }])
  expect(plain).toBe('```diff\n+a\n-b\n```')

  // A patch to a Markdown file carries its own fences; four backticks keep them from closing ours.
  const markdown = inlinePatch([{ text: '+```ts\n+const a = 1\n+```\n' }])
  expect(markdown.startsWith('````diff\n')).toBe(true)
  expect(markdown.endsWith('\n````')).toBe(true)
})

// Why pinned: a patch to these templates, or to shell or regex code, carries `{{NAME}}` and `$&`. One
// pass with a function replacer leaves both byte for byte; an iterative render or a string
// replacement would expand or corrupt them inside the patch a reviewer is judging.
it('renders a patch byte for byte, placeholders and replacement patterns included', () => {
  const patch = inlinePatch([{ text: '+see {{SLICE_ID}} and $& and $1 and $$\n' }])
  const out = renderTemplate('A {{SLICE_ID}}\n{{SLICE_PATCH_TEXT}}\nZ', {
    SLICE_ID: 'B',
    SLICE_PATCH_TEXT: patch
  })
  expect(out).toBe(`A B\n${patch}\nZ`)
})

it('puts the delta in the delta prompt', () => {
  const repo = tempGitRepo('orca-review-inline-delta-')
  dirs.push(repo.dir)
  repo.commit('base', { 'src/a.ts': 'one\n' })
  const r1 = repo.git('rev-parse', 'HEAD').trim()
  repo.commit('fix', { 'src/a.ts': 'two\n' })
  const r2 = repo.git('rev-parse', 'HEAD').trim()
  const parentDir = mkdtempSync(join(tmpdir(), 'orca-review-inline-packet-'))
  dirs.push(parentDir)
  prepareDelta({
    root: repo.dir,
    range: `${r1}..${r2}`,
    findings: [],
    parentDir,
    context: {
      lintSteps: new Set(),
      postSyncRows: new Set(),
      mobilePostinstall: '',
      lintStepReading: () => null
    }
  })
  const dir = readdirSync(parentDir).find((name) => name.startsWith('delta-'))
  const prompt = readFileSync(join(parentDir, dir, 'prompt-delta-1.txt'), 'utf8')
  const patch = readFileSync(join(parentDir, dir, 'delta.patch'), 'utf8')
  expect(patch).toContain('+two')
  expect(prompt).toContain(`\`\`\`diff\n${patch}\`\`\``)
  expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
})
