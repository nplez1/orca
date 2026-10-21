// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isListOwnSelectAllTarget, partitionSshTargetsByVisibility } from './SshTargetList'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string): HTMLElement {
  const list = document.createElement('div')
  list.innerHTML = html
  document.body.append(list)
  return list
}

describe('⌘/Ctrl-A on the SSH host list', () => {
  it('selects hosts from a row control inside the list', () => {
    const list = mount('<button id="row">Connect</button>')
    expect(isListOwnSelectAllTarget(list, list.querySelector('#row'))).toBe(true)
  })

  // React bubbles keydown through portals, so a row dialog's event reaches the list handler.
  it('ignores events from portalled dialogs and menus outside the list', () => {
    const list = mount('<button>Connect</button>')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.innerHTML = '<button id="inside">Restart</button>'
    document.body.append(dialog)
    expect(isListOwnSelectAllTarget(list, dialog.querySelector('#inside'))).toBe(false)
  })

  it('leaves text selection alone in fields, menus and detail text inside the list', () => {
    const list = mount(
      '<input id="field" /><div role="menu"><div id="item">Edit</div></div><pre id="detail">log</pre>'
    )
    for (const id of ['field', 'item', 'detail']) {
      expect(isListOwnSelectAllTarget(list, list.querySelector(`#${id}`))).toBe(false)
    }
  })
})

const hiddenTarget = {
  id: 'ssh-hidden',
  label: 'prod',
  configHost: 'prod',
  host: 'prod.internal',
  port: 22,
  username: 'deploy',
  source: 'ssh-config' as const,
  hidden: true
}

const offeredTarget = {
  id: 'ssh-offered',
  label: 'build-01',
  host: 'build-01.internal',
  port: 22,
  username: 'deploy',
  source: 'manual' as const
}

function offeredAndHidden(targets: Parameters<typeof partitionSshTargetsByVisibility>[0]): {
  offered: string[]
  hidden: string[]
} {
  const partition = partitionSshTargetsByVisibility(targets)
  return {
    offered: partition.offered.map((target) => target.label),
    hidden: partition.hidden.map((target) => target.label)
  }
}

describe('which SSH hosts the list shows', () => {
  // Why: a host ~/.ssh/config keeps re-importing cannot be removed, so it is hidden instead —
  // and the hidden section is the only place that can show and undo that choice.
  it('keeps a hidden host out of the offered rows and counts it in the hidden section', () => {
    expect(offeredAndHidden([offeredTarget, hiddenTarget])).toEqual({
      offered: ['build-01'],
      hidden: ['prod']
    })
  })

  it('renders no hidden section when every host is offered', () => {
    expect(offeredAndHidden([offeredTarget])).toEqual({ offered: ['build-01'], hidden: [] })
  })
})
