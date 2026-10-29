// Fixture tests for the fork-symbol survival rules. No git, no filesystem:
//   node --test local/sync/lib/fork-symbols.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import { forkAdded, forkSurface, manifestEntry, survivalVerdict } from './fork-symbols.mjs'

const names = (text, file = 'src/a.ts') => [...forkSurface(file, text).keys()].sort()

test('the surface is top-level declarations plus the members a reader could lose', () => {
  const text = [
    'export function run() {}',
    'function local() { const inner = 1 }',
    'export class Store { field = 1; read() {} }',
    'export interface Settings { forkToggle: boolean }',
    'export type Options = { a: string } & { b: number }',
    'export enum Mode { Fork = 1 }',
    "export const DEFAULTS = { forkToggle: false, 'quoted-key': 1 } as const",
    'const [first, { second }] = pair()',
    "export { run as start } from './run'",
    'declare namespace Ns {}'
  ].join('\n')
  assert.deepEqual(names(text), [
    'DEFAULTS',
    'DEFAULTS.forkToggle',
    'DEFAULTS.quoted-key',
    'Mode',
    'Mode.Fork',
    'Ns',
    'Options',
    'Options.a',
    'Options.b',
    'Settings',
    'Settings.forkToggle',
    'Store',
    'Store.field',
    'Store.read',
    'first',
    'local',
    'run',
    'second',
    'start'
  ])
  assert.equal(forkSurface('src/a.ts', text).get('run').exported, true)
  assert.equal(forkSurface('src/a.ts', text).get('local').exported, false)
})

test('a file that does not parse has no surface, rather than an empty one', () => {
  assert.equal(forkSurface('src/a.ts', 'export const = ('), null)
  assert.equal(forkSurface('docs/a.md', '# title'), null)
})

test('fork-added is what the tip declares that old-base did not', () => {
  const before = forkSurface('src/a.ts', 'export interface S { up: string }')
  const after = forkSurface(
    'src/a.ts',
    'export interface S { up: string; fork: boolean }\nexport function forkOnly() {}'
  )
  assert.deepEqual(
    forkAdded(before, after).map((symbol) => symbol.name),
    ['S.fork', 'forkOnly']
  )
  assert.deepEqual(
    forkAdded(null, after).map((symbol) => symbol.name),
    ['S', 'S.up', 'S.fork', 'forkOnly']
  )
})

const added = forkAdded(
  forkSurface('src/a.ts', 'export interface S { up: string }'),
  forkSurface(
    'src/a.ts',
    'export interface S { up: string; fork: boolean }\nexport function moved() {}\nexport function gone() {}\nexport function kept() {}'
  )
)
const verdicts = (acknowledgements = [], referenced = new Set(['moved'])) =>
  Object.fromEntries(
    survivalVerdict({
      path: 'src/a.ts',
      added,
      merged: forkSurface(
        'src/a.ts',
        'export interface S { up: string }\nexport function kept() {}'
      ),
      referenced,
      acknowledgements
    }).map((result) => [result.name, result.verdict])
  )

test('a surviving name is silent; a lost one is lost unless its bare name lives on elsewhere', () => {
  assert.deepEqual(verdicts(), { 'S.fork': 'lost', moved: 'relocated', gone: 'lost' })
})

test('only a settled manifest entry acknowledges a loss; pending and restore do not', () => {
  const entry = (symbol, status) => ({ path: 'src/a.ts', symbol, status, supersededBy: 'x.ts' })
  assert.deepEqual(
    verdicts([
      entry('gone', 'expected-deletion'),
      entry('S.fork', 'restore'),
      entry('moved', 'pending-decision')
    ]),
    { 'S.fork': 'lost', moved: 'relocated', gone: 'acknowledged' }
  )
  assert.deepEqual(
    verdicts([{ path: 'src/other.ts', symbol: 'gone', status: 'expected-deletion' }]).gone,
    'lost'
  )
})

test('a merged file that is gone loses every fork-added name', () => {
  const results = survivalVerdict({
    path: 'src/a.ts',
    added,
    merged: new Map(),
    referenced: new Set(),
    acknowledgements: []
  })
  assert.equal(results.length, added.length)
})

test('the manifest entry is pending until a reviewer settles it', () => {
  assert.deepEqual(manifestEntry({ path: 'src/a.ts', name: 'S.fork' }), {
    path: 'src/a.ts',
    symbol: 'S.fork',
    status: 'pending-decision',
    supersededBy: null,
    reason: ''
  })
})

test('a member reached through an arrow body, a call argument or a nested literal is a name', () => {
  // The shapes Zustand slices, factory calls and nested settings defaults actually use. Before this,
  // every one of them returned nothing at all.
  const text = [
    'const useUiStore = create<State>((set) => ({ npFlag: true }))',
    'const createUiSlice = (set) => ({ npSliceFlag: false })',
    'const useSlice = create(() => ({ forkField: 1 }))',
    'const DEFAULTS = { nested: { forkNested: 2 } }',
    'function factory() { return { fromReturn: 1 } }',
    'export default { forkMember: true, other: { deeper: 1 } }'
  ].join('\n')
  assert.deepEqual(names(text), [
    'DEFAULTS',
    'DEFAULTS.nested',
    'DEFAULTS.nested.forkNested',
    'createUiSlice',
    'createUiSlice.npSliceFlag',
    'default',
    'default.forkMember',
    'default.other',
    'default.other.deeper',
    'factory',
    'factory.fromReturn',
    'useSlice',
    'useSlice.forkField',
    'useUiStore',
    'useUiStore.npFlag'
  ])
})

test('a channel any call in the module registers is a name, including inside a register function', () => {
  const text = [
    "ipcMain.handle('np:fork-channel', () => 1)",
    'ipcMain.on(`np:template-channel`, () => 2)',
    'export function register() {',
    "  ipcMain.handle('np:inside-a-function', () => 3)",
    '}',
    'const emitter = new EventEmitter()',
    "emitter.on('np:emitter-channel', () => 4)"
  ].join('\n')
  const surface = forkSurface('src/main/ipc.ts', text)
  assert.deepEqual([...surface.keys()].sort(), [
    'channel:np:emitter-channel',
    'channel:np:fork-channel',
    'channel:np:inside-a-function',
    'channel:np:template-channel',
    'emitter',
    'register'
  ])
  assert.equal(surface.get('channel:np:fork-channel').kind, 'channel')
})

test('a nested literal inside a class member is not invented', () => {
  // Recursion follows object literals only; a class member's value is not one.
  const text = 'export class Store {\n  method() { return { notAMember: 1 } }\n}'
  assert.deepEqual(names(text), ['Store', 'Store.method'])
})
