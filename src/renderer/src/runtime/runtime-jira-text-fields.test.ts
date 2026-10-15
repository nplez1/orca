import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foldIssueUpdateForTarget, foldTextFieldsForTarget } from './runtime-jira-text-fields'

const { supportsMock } = vi.hoisted(() => ({ supportsMock: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: (...args: unknown[]) => supportsMock(...args)
}))

describe('foldTextFieldsForTarget', () => {
  beforeEach(() => {
    supportsMock.mockReset()
  })

  it('keeps plain text and the keys for a host that converts them', async () => {
    supportsMock.mockResolvedValue(true)

    const result = await foldTextFieldsForTarget(
      { kind: 'environment', environmentId: 'env-1' },
      { f: 'x' },
      ['f']
    )

    expect(result).toEqual({ values: { f: 'x' }, textFieldKeys: ['f'] })
  })

  it('folds to ADF and drops the keys for an older host', async () => {
    supportsMock.mockResolvedValue(false)

    const result = await foldTextFieldsForTarget(
      { kind: 'environment', environmentId: 'env-1' },
      { f: 'line' },
      ['f']
    )

    expect(result.textFieldKeys).toBeUndefined()
    expect(result.values?.f).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'line' }] }]
    })
  })

  it('leaves a local target for the host to convert', async () => {
    const result = await foldTextFieldsForTarget({ kind: 'local' }, { f: 'x' }, ['f'])

    expect(supportsMock).not.toHaveBeenCalled()
    expect(result).toEqual({ values: { f: 'x' }, textFieldKeys: ['f'] })
  })

  it('does nothing when no textarea field is named', async () => {
    expect(await foldTextFieldsForTarget({ kind: 'local' }, { f: 'x' }, undefined)).toEqual({
      values: { f: 'x' },
      textFieldKeys: undefined
    })
  })
})

describe('foldIssueUpdateForTarget', () => {
  beforeEach(() => {
    supportsMock.mockReset()
  })

  it('folds both the field edit and the transition screen on an older host', async () => {
    supportsMock.mockResolvedValue(false)

    const folded = await foldIssueUpdateForTarget(
      { kind: 'environment', environmentId: 'env-1' },
      {
        transitionId: '5',
        customFields: { customfield_1: 'a' },
        textFieldKeys: ['customfield_1'],
        transitionFields: { customfield_2: 'b' },
        transitionTextFieldKeys: ['customfield_2']
      }
    )

    expect(folded.textFieldKeys).toBeUndefined()
    expect(folded.transitionTextFieldKeys).toBeUndefined()
    expect(folded.customFields?.customfield_1).toMatchObject({ type: 'doc' })
    expect(folded.transitionFields?.customfield_2).toMatchObject({ type: 'doc' })
  })

  it('passes an update with no textarea fields through untouched', async () => {
    const updates = { title: 'Fix auth' }

    expect(await foldIssueUpdateForTarget({ kind: 'local' }, updates)).toBe(updates)
    expect(supportsMock).not.toHaveBeenCalled()
  })
})
