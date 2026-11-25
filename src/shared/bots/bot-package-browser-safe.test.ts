import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the renderer value-imports bot-package (settings/bots/BotSkillsSection), and Vite stubs node
// builtins in the browser with a proxy that throws on access, so one builtin anywhere in this graph
// breaks the Bot activity panel under `pnpm dev` and every component fixture.
const ENTRY = resolve(import.meta.dirname, 'bot-package.ts')
const BUILTINS = new Set(builtinModules)
const SPECIFIER_PATTERNS = [
  // import x from '…', import { a } from '…', export { a } from '…' — type-only forms are erased.
  /^\s*(?:import|export)\s+(?!type\s)[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm,
  // import '…'
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  // import('…'), require('…')
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

function runtimeSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1])
  )
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier)
  const candidate = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(
    (path) => /\.tsx?$/.test(path) && existsSync(path)
  )
  if (!candidate) {
    throw new Error(`cannot resolve ${specifier} from ${fromFile}`)
  }
  return candidate
}

function builtinImportsReachableFrom(entry: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier))
      } else if (specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0])) {
        found.push(`${file}: ${specifier}`)
      }
    }
  }
  return found
}

describe('bot-package runtime import graph', () => {
  it('reaches no node builtin, so the renderer can load it', () => {
    expect(builtinImportsReachableFrom(ENTRY)).toEqual([])
  })
})
