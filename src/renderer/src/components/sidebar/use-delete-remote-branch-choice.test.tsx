// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDeleteRemoteBranchChoice } from './use-delete-remote-branch-choice'

function setup(initialProps: { isOpen: boolean; settingDefault: boolean }) {
  return renderHook(
    ({ isOpen, settingDefault }: { isOpen: boolean; settingDefault: boolean }) =>
      useDeleteRemoteBranchChoice(isOpen, settingDefault),
    { initialProps }
  )
}

describe('useDeleteRemoteBranchChoice', () => {
  it('starts unchecked so the remote branch survives a delete the user did not opt into', () => {
    const { result } = setup({ isOpen: true, settingDefault: false })

    expect(result.current.checked).toBe(false)
    expect(result.current.options).toEqual({})
  })

  it('starts checked when the setting asks for it', () => {
    const { result } = setup({ isOpen: true, settingDefault: true })

    expect(result.current.checked).toBe(true)
    expect(result.current.options).toEqual({ deleteRemoteBranch: true })
  })

  it('lets a manual choice override the setting either way', () => {
    const { result, rerender } = setup({ isOpen: true, settingDefault: true })

    act(() => result.current.setChecked(false))
    expect(result.current.checked).toBe(false)
    expect(result.current.options).toEqual({})

    rerender({ isOpen: true, settingDefault: false })
    act(() => result.current.setChecked(true))
    expect(result.current.options).toEqual({ deleteRemoteBranch: true })
  })

  // The setting supplies a default per open, not a sticky dialog intent: a user who unchecks the
  // box and then cancels must not have that cancellation silently applied to their next delete.
  it('re-seeds from the setting on the next open', () => {
    const { result, rerender } = setup({ isOpen: true, settingDefault: true })

    act(() => result.current.setChecked(false))
    expect(result.current.checked).toBe(false)

    rerender({ isOpen: false, settingDefault: true })
    rerender({ isOpen: true, settingDefault: true })
    expect(result.current.checked).toBe(true)
  })
})
