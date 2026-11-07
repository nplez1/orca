import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** The bus half of the scheduled-work lane: which `pi.events` this pane's inventory is asked on.
 *
 *  Adopting it belongs to the pane-owning registration, so it happens in the fenced `session_start`
 *  handler and never at factory time — pi-subagents runs its children in-process on their own bus and with
 *  the same pid, so a factory-scope adoption would let the first subagent (or the first cold job firing,
 *  this feature's own headline case) point the lead's refreshes at a bus that serves no loops at all.
 *
 *  Keyed by bus for the same reason the async-child lane is: Pi hands a re-run factory its own `pi.events`
 *  while `/reload` keeps the module, so a bus this lane has not armed is armed, and the binding it replaces
 *  is released rather than accumulated. */
export function getPiAgentStatusScheduledWorkSessionStartLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return ['    piScheduledWorkAdoptBus(pi)', '']
}

/** The module-level half of the adoption above, emitted with the rest of the module. */
export function getPiAgentStatusScheduledWorkBusLines(kind: PiAgentKind): string[] {
  if (kind !== 'pi') {
    return []
  }

  return [
    'function piScheduledWorkReleaseBinding(): void {',
    '  const binding = piScheduledWork.binding',
    '  if (!binding) return',
    '  piScheduledWork.binding = null',
    '  for (const entry of binding.listeners) {',
    '    try {',
    '      if (typeof entry.release === "function") (entry.release as () => void)()',
    '      else if (typeof binding.bus.off === "function") binding.bus.off(entry.channel, entry.listener)',
    '    } catch {',
    '      // A bus without a release path dies with its registration; nothing else can hold it.',
    '    }',
    '  }',
    '  binding.listeners.length = 0',
    '}',
    '',
    'function piScheduledWorkAdoptBus(source: unknown): void {',
    '  if (isOmpRuntime()) return',
    '  const bus = (source as { events?: PiScheduledWorkBus } | null)?.events',
    "  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') return",
    '  if (piScheduledWork.bus !== bus) {',
    '    piScheduledWorkReleaseBinding()',
    '    piScheduledWork.bus = bus',
    '    // Why the cache survives: it lives on globalThis so a reload does not rebuild it empty, and the',
    '    // new bus answers before the next flush. A slice nothing serves is retired by its own ask.',
    '  }',
    '  if (!piScheduledWork.binding) {',
    '    try {',
    '      const binding: PiScheduledWorkBinding = { bus, listeners: [] }',
    '      piScheduledWork.binding = binding',
    '      const onScheduledChange = (): void => { piScheduledWorkRefresh() }',
    '      for (const channel of PI_SCHEDULED_WORK_EVENT_CHANNELS) {',
    '        const release = bus.on(channel, onScheduledChange)',
    '        binding.listeners.push({ channel, listener: onScheduledChange, release })',
    '      }',
    '    } catch {',
    '      // Why: status reporting must never fail the pi run; an unavailable bus just means no inventory.',
    '    }',
    '  }',
    '  piScheduledWorkRefresh()',
    '}',
    ''
  ]
}
