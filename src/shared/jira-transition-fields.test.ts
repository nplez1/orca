import { describe, expect, it } from 'vitest'
import {
  buildResolutionFieldValue,
  transitionAllowedValueKey,
  classifyTransitionRequirements,
  requiredTransitionFields,
  transitionAllowedValueLabel
} from './jira-transition-fields'
import type { JiraTransition } from './jira-types'

const baseTo = {
  id: '3',
  name: 'Done',
  categoryKey: 'done',
  categoryName: 'Done'
}

function transition(fields: JiraTransition['fields']): JiraTransition {
  return { id: '31', name: 'Done', to: baseTo, fields }
}

describe('jira-transition-fields', () => {
  it('treats transitions without required fields as one-click', () => {
    expect(classifyTransitionRequirements(transition(undefined))).toEqual({ kind: 'none' })
    expect(
      classifyTransitionRequirements(
        transition([
          {
            key: 'comment',
            name: 'Comment',
            required: false,
            schema: { type: 'string', system: 'comment' }
          }
        ])
      )
    ).toEqual({ kind: 'none' })
    expect(requiredTransitionFields(transition(undefined))).toEqual([])
  })

  it('does not ask for a required field Jira will default itself', () => {
    // Why the fork's rule: prompting for a field the site fills in itself turns a
    // valid move into a blocked one.
    const defaulted = {
      key: 'customfield_10001',
      name: 'Dev',
      required: true,
      hasDefaultValue: true,
      schema: { type: 'string' }
    }
    expect(requiredTransitionFields(transition([defaulted]))).toEqual([])
    expect(classifyTransitionRequirements(transition([defaulted]))).toEqual({ kind: 'none' })
  })

  it('does not ask for a required field the issue already fills', () => {
    // Why: Jira's `required` is the transition screen's flag, not a statement that
    // this issue is missing the field, so a filled field is not input the user owes.
    const filled = [
      {
        key: 'components',
        name: 'Component/s',
        required: true,
        currentValue: '10400',
        currentDisplayValue: 'Web',
        schema: { type: 'array', items: 'string' }
      },
      {
        key: 'customfield_10002',
        name: 'Team',
        required: true,
        currentValue: 'team-1',
        schema: { type: 'array', items: 'string' }
      }
    ]
    expect(requiredTransitionFields(transition(filled))).toEqual([])
    expect(classifyTransitionRequirements(transition(filled))).toEqual({ kind: 'none' })
  })

  it('still asks for resolution and comment when the issue holds a value', () => {
    // Why: a workflow can require the user to set them on this transition even when
    // a value already exists, which is what Jira's own screen does.
    const resolution = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      currentValue: '10000',
      schema: { type: 'resolution', system: 'resolution' },
      allowedValues: [{ id: '10000', name: 'Done' }]
    }
    const comment = {
      key: 'comment',
      name: 'Comment',
      required: true,
      currentValue: 'existing note',
      schema: { type: 'string', system: 'comment' }
    }
    expect(requiredTransitionFields(transition([resolution, comment]))).toEqual([
      resolution,
      comment
    ])
  })

  it('classifies resolution (+ optional required comment) as a supported form', () => {
    const resolution = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      schema: { type: 'resolution', system: 'resolution' },
      allowedValues: [
        { id: '10000', name: 'Done' },
        { id: '10001', name: "Won't Do" }
      ]
    }
    expect(classifyTransitionRequirements(transition([resolution]))).toEqual({
      kind: 'form',
      resolution,
      commentRequired: false,
      fields: []
    })
    expect(
      classifyTransitionRequirements(
        transition([
          resolution,
          {
            key: 'comment',
            name: 'Comment',
            required: true,
            schema: { type: 'string', system: 'comment' }
          }
        ])
      )
    ).toEqual({
      kind: 'form',
      resolution,
      commentRequired: true,
      fields: []
    })
  })

  it('collects a required custom field beside a required resolution', () => {
    // Why no unsupported kind: every field gets a control, so a required field
    // Orca can render is collected rather than used to refuse the move.
    const custom = {
      key: 'customfield_10050',
      name: 'Close Reason',
      required: true,
      schema: {
        type: 'option',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select'
      },
      allowedValues: [{ id: '1', value: 'Fixed' }]
    }
    const resolution = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      schema: { type: 'resolution' },
      allowedValues: [{ id: '10000', name: 'Done' }]
    }
    expect(classifyTransitionRequirements(transition([custom, resolution]))).toEqual({
      kind: 'form',
      resolution,
      commentRequired: false,
      fields: [custom]
    })
  })

  it('treats a custom field whose schema hints at resolution or comment as its own field', () => {
    // Why: only the system keys are Jira's resolution and comment; a customfield
    // carrying the same schema hint is a shape Orca renders like any other.
    const customResolution = {
      key: 'customfield_10050',
      name: 'Close reason',
      required: true,
      schema: { type: 'resolution' },
      allowedValues: [{ id: '1', name: 'Fixed' }]
    }
    const customComment = {
      key: 'customfield_10051',
      name: 'Notes',
      required: true,
      schema: { system: 'comment' }
    }
    expect(classifyTransitionRequirements(transition([customResolution, customComment]))).toEqual({
      kind: 'form',
      resolution: null,
      commentRequired: false,
      fields: [customResolution, customComment]
    })
  })

  it('renders one control for a field Jira lists twice', () => {
    // Why: asking twice would submit the same key and lose the second value.
    const first = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      allowedValues: [{ id: '1', name: 'Fixed' }]
    }
    const second = { ...first, allowedValues: [{ id: '2', name: 'Duplicate' }] }
    expect(classifyTransitionRequirements(transition([first, second]))).toEqual({
      kind: 'form',
      resolution: first,
      commentRequired: false,
      fields: []
    })
  })

  it('falls back to a text control when required resolution choices are missing', () => {
    const resolution = { key: 'resolution', name: 'Resolution', required: true }
    expect(classifyTransitionRequirements(transition([resolution]))).toEqual({
      kind: 'form',
      resolution: null,
      commentRequired: false,
      fields: [resolution]
    })
  })

  it('builds resolution payloads from allowed values', () => {
    const field = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      allowedValues: [
        { id: '10000', name: 'Done' },
        { name: 'Duplicate' },
        { id: '  ', value: 'Fixed' }
      ]
    }
    expect(buildResolutionFieldValue(field, '10000')).toEqual({ id: '10000' })
    expect(buildResolutionFieldValue(field, 'Duplicate')).toEqual({ name: 'Duplicate' })
    expect(buildResolutionFieldValue(field, '  ')).toBeNull()
    expect(buildResolutionFieldValue(field, 'unknown')).toBeNull()
    expect(buildResolutionFieldValue(field, 'Fixed')).toEqual({ value: 'Fixed' })
    expect(transitionAllowedValueLabel({ id: '1', name: 'Done' })).toBe('Done')
    expect(transitionAllowedValueKey({ id: '1', name: 'Done', value: 'done' })).toBe('1')
    expect(transitionAllowedValueKey({ name: 'Duplicate', value: 'dup' })).toBe('dup')
    expect(transitionAllowedValueKey({ name: 'OnlyName' })).toBe('OnlyName')
    expect(transitionAllowedValueKey({ id: '', value: 'dup' })).toBe('dup')
    expect(transitionAllowedValueKey({ id: '  ', name: 'Duplicate' })).toBe('Duplicate')
  })
})
