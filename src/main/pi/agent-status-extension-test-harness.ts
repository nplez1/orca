import { EventEmitter } from 'node:events'
import { createContext, runInContext } from 'node:vm'
// TypeScript 7 is a native CLI; transpile tests still need the legacy JavaScript API.
import ts from 'typescript-api'
import { vi } from 'vitest'

import { createTrackedPiEventBus, type PiEventBus } from './agent-status-extension-test-event-bus'
import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'
import { AGENT_STATUS_EXTENSION_BASE_ENV } from './agent-status-extension-test-env'

export type HookContext = {
  hasUI?: boolean
  ui?: {
    setEditorText?: (text: string) => void
    notify?: (message: string, level: string) => void
    onTerminalInput?: (handler: (data: string) => { consume?: boolean } | undefined) => () => void
  }
  isIdle?: () => boolean
  getAsyncJobSnapshot?: () => { running: { type: string; agentId?: string; label: string }[] }
  resolvePlanReview?: (reviewId: string, choice: string) => boolean
  model?: { provider?: unknown; id?: unknown } | null
  modelRegistry?: { getAvailable: () => { provider: string; id: string }[] }
  sessionManager?: {
    getSessionId?: () => unknown
    getSessionFile?: () => unknown
    getHeader?: () => unknown
  }
}

export type HookHandler = (event?: unknown, context?: HookContext) => Promise<void> | void

type FakeCurlChild = {
  kill: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => boolean
  on: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

export type AgentStatusExtensionHarness = {
  setModelMock: ReturnType<typeof vi.fn>
  commands: Record<string, { handler: (args: string, context: HookContext) => Promise<void> }>
  killMock: ReturnType<typeof vi.fn>
  fetchMock: ReturnType<typeof vi.fn>
  spawnMock: ReturnType<typeof vi.fn>
  spawnedChildren: FakeCurlChild[]
  fsMock: {
    existsSync: ReturnType<typeof vi.fn>
    readFileSync: ReturnType<typeof vi.fn>
    statSync: ReturnType<typeof vi.fn>
  }
  handlers: Record<string, HookHandler>
  processEnv: Record<string, string | undefined>
  callHook: (name: string, event?: unknown, context?: HookContext) => Promise<void>
  emitPiEvent: (name: string, event: unknown) => void
  piEventListenerCount: (name: string) => number
  reload: () => void
  // /new, resume and fork replace registration and bus while retaining module state.
  replacePiSession: (reason: 'new' | 'resume' | 'fork', targetSessionFile?: string) => Promise<void>
  // /reload also reevaluates the module, preserving globalThis.
  reloadPi: () => Promise<void>
  // An OMP in-process task child: the same module's factory, run again on the child's own bus.
  // Returns that registration's bus, so a test can drive its hooks and events and count what it
  // armed — a second factory is what a per-evaluation binding policy has to stay honest about.
  registerTaskChild: () => {
    emitPiEvent: (name: string, event: unknown) => void
    callHook: (name: string, event?: unknown, context?: HookContext) => Promise<void>
    piEventListenerCount: (name: string) => number
  }
}

// Why: ownership keys on process.pid, so reload and child-process tests need
// stable, distinct identities.
export const AGENT_STATUS_EXTENSION_SELF_PID = 4242

const transpiledExtensionSources = new Map<string, string>()

function transpileExtensionSource(source: string): string {
  const cached = transpiledExtensionSources.get(source)
  if (cached !== undefined) {
    return cached
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText
  transpiledExtensionSources.set(source, output)
  return output
}

export function createAgentStatusExtensionHarness(args: {
  kind: 'pi' | 'omp' | 'prime-agent'
  killImpl?: (pid: number, signal: number) => void
  env?: Record<string, string | undefined>
  pid?: number
  title?: string
  argv?: readonly string[]
  existsSync?: (path: string) => boolean
  readFileSync?: (path: string, encoding: string) => string
  statSync?: (path: string) => { mtimeMs: number; size: number; ino: number }
  curlExitCode?: number | null
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
  seedEventBus?: (bus: EventEmitter) => void
  // OMP hands extensions its package exports as `pi.pi`.
  ompModule?: unknown
  // Pi versions before 0.84 shared one event bus across registrations.
  sharedEventBus?: boolean
}): AgentStatusExtensionHarness {
  const fetchMock = vi.fn(
    args.fetchImpl ??
      (async () => ({
        ok: true
      }))
  )

  const spawnedChildren: FakeCurlChild[] = []
  const spawnMock = vi.fn(() => {
    const emitter = new EventEmitter()
    const child: FakeCurlChild = {
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(() => emitter.emit('close', null)),
      on: vi.fn(emitter.on.bind(emitter)),
      stdin: {
        on: vi.fn(),
        end: vi.fn()
      }
    }
    spawnedChildren.push(child)
    if (args.curlExitCode !== null) {
      void Promise.resolve().then(() => emitter.emit('close', args.curlExitCode ?? 0))
    }
    return child
  })

  const fsMock = {
    existsSync: vi.fn(args.existsSync ?? (() => false)),
    statSync: vi.fn(
      args.statSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    ),
    readFileSync: vi.fn(
      args.readFileSync ??
        ((path: string) => {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        })
    )
  }

  const module: {
    exports: {
      default?: (pi: {
        on: (name: string, handler: HookHandler) => void
        registerCommand: (
          name: string,
          command: { handler: (args: string, context: HookContext) => Promise<void> }
        ) => void
        setModel: (model: unknown) => Promise<boolean>
        events?: PiEventBus
        pi?: unknown
      }) => void
    }
  } = { exports: {} }
  const requireMock = vi.fn((specifier: string) => {
    if (specifier === 'fs') {
      return fsMock
    }
    if (specifier === 'child_process') {
      return { spawn: spawnMock }
    }
    throw new Error(`unexpected require(${specifier})`)
  })

  const killMock = vi.fn(args.killImpl ?? (() => undefined))
  const processMock = {
    kill: killMock,
    env: {
      ...AGENT_STATUS_EXTENSION_BASE_ENV,
      ...(args.kind === 'prime-agent' ? { PRIME_AGENT_INTERNAL_DAEMON_WORKER: '1' } : {}),
      ...args.env
    },
    pid: args.pid ?? AGENT_STATUS_EXTENSION_SELF_PID,
    title: args.title ?? 'node',
    argv: args.argv ?? ['node', '/usr/bin/orca']
  }

  const context = {
    module,
    exports: module.exports,
    require: requireMock,
    process: processMock,
    fetch: fetchMock,
    console: {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    },
    Promise,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  } as Record<string, unknown>
  context.globalThis = context

  const source = getPiAgentStatusExtensionSource(args.kind)
  const output = transpileExtensionSource(source)
  createContext(context)
  // Wrap evaluations so reload can reuse the same VM realm.
  const evaluateModule = (): NonNullable<typeof module.exports.default> => {
    runInContext(`(function () {\n${output}\n})()`, context)
    const factory = module.exports.default
    if (!factory) {
      throw new Error('expected default export from generated source')
    }
    return factory
  }
  let register = evaluateModule()

  const handlers: Record<string, HookHandler> = {}
  // Pi invokes handlers in registration order.
  let handlerLists: Record<string, HookHandler[]> = {}
  let piEvents = new EventEmitter()
  let busSubscriptions: [string, (event: unknown) => void][] = []
  // Why: the object Pi handed the extension as `pi.events` for this bus. Pi re-runs the factory
  // when it replaces the registration's handlers but not its bus, so that re-run has to see the
  // SAME object — an extension that carries bus identity must read one bus, not two.
  let piEventsObject: PiEventBus | null = null
  const commands: AgentStatusExtensionHarness['commands'] = {}
  const setModelMock = vi.fn(async (_model: unknown) => true)
  const registerInto = (
    target: Record<string, HookHandler>,
    events: PiEventBus = piEvents
  ): void => {
    handlerLists = {}
    register({
      registerCommand: (name, command) => {
        commands[name] = command
      },
      setModel: setModelMock,
      events,
      pi: args.ompModule,
      on(name: string, handler: HookHandler) {
        target[name] = handler
        ;(handlerLists[name] ??= []).push(handler)
      }
    })
  }
  const callHook: AgentStatusExtensionHarness['callHook'] = async (name, event, hookContext) => {
    for (const handler of handlerLists[name] ?? []) {
      await handler(event, hookContext)
    }
  }
  // Replacing a registration removes its subscriptions and per-bus stored state.
  const registerLikePi = (): void => {
    for (const [name, listener] of busSubscriptions) {
      piEvents.off(name, listener)
    }
    busSubscriptions.length = 0
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    piEventsObject = createTrackedPiEventBus(piEvents, busSubscriptions)
    registerInto(handlers, piEventsObject)
  }
  args.seedEventBus?.(piEvents)
  if (args.kind === 'pi' && !args.sharedEventBus) {
    registerLikePi()
  } else {
    registerInto(handlers)
  }

  return {
    setModelMock,
    commands,
    fetchMock,
    killMock,
    spawnMock,
    spawnedChildren,
    fsMock,
    handlers,
    processEnv: processMock.env,
    callHook,
    emitPiEvent: (name, event) => {
      piEvents.emit(name, event)
    },
    piEventListenerCount: (name) => piEvents.listenerCount(name),
    reload: () => {
      for (const key of Object.keys(handlers)) {
        delete handlers[key]
      }
      // Why: re-running the factory does not replace the registration, so it is handed the bus
      // object it already has — only a new session (`replacePiSession`) gets a new one.
      registerInto(handlers, piEventsObject ?? piEvents)
    },
    replacePiSession: async (reason, targetSessionFile) => {
      await callHook('session_shutdown', { reason, targetSessionFile })
      piEvents = new EventEmitter()
      registerLikePi()
    },
    registerTaskChild: () => {
      const leadHandlerLists = handlerLists
      const childBus = new EventEmitter()
      registerInto({}, childBus)
      const childHandlerLists = handlerLists
      handlerLists = leadHandlerLists
      return {
        emitPiEvent: (name: string, event: unknown) => {
          childBus.emit(name, event)
        },
        callHook: async (name: string, event?: unknown, context?: HookContext) => {
          for (const handler of childHandlerLists[name] ?? []) {
            await handler(event, context)
          }
        },
        piEventListenerCount: (name: string) => childBus.listenerCount(name)
      }
    },
    reloadPi: async () => {
      await callHook('session_shutdown', { reason: 'reload' })
      register = evaluateModule()
      registerLikePi()
    }
  }
}
