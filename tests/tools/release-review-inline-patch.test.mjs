import { expect, it } from 'vitest'
import { inlinePatch } from '../../local/review-packets/packet.mjs'

it('fences the patch with a run longer than any backtick run inside it', () => {
  const plain = inlinePatch([{ text: '+a\n' }, { text: '-b' }])
  expect(plain).toBe('```diff\n+a\n-b\n```')

  // A patch to a Markdown file carries its own fences; four backticks keep them from closing ours.
  const markdown = inlinePatch([{ text: '+```ts\n+const a = 1\n+```\n' }])
  expect(markdown.startsWith('````diff\n')).toBe(true)
  expect(markdown.endsWith('\n````')).toBe(true)
})
