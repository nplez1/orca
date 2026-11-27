import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { ChoicePatch, OptionKey } from '../agent-launch/agent-launch-settings-params'
import { AGENT_PERMISSION_CHOICES } from '../../agent-launch/permissions/tui-agent-permission-choice'
import {
  AutomationBotTarget,
  AutomationEventTriggers,
  AutomationOnceParam
} from '../automation-bot-params'
import {
  OptionalBoolean,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString,
  requiredNumber,
  requiredString
} from '../rpc-param-primitives'
import { refuseUnknownNamedZone } from './automation-timezone-param'
import {
  AutomationPrecheck,
  AutomationSchedule,
  AutomationWorkspaceMode,
  Destination,
  ExpectedOwner,
  OptionalNullablePlainString,
  SetupDecision,
  TaskSourceContext,
  TuiAgent,
  WorkspaceRunContext
} from './automation-selector-params'

export * from './automation-selector-params'

// Why strict: null or a non-string must fail rather than fall back to "omitted", which preserves.
const ExtraAgentArgs = lazyZodSchema(() =>
  z.string({ message: 'Extra agent arguments must be text.' }).optional()
)

/** A stored command: one shell line, its deadline, and the shell and delivery it asks for. */
const AutomationScriptParam = lazyZodSchema(() =>
  z.strictObject({
    // 4000 chars mirrors MAX_AUTOMATION_COMMAND_LENGTH: a command is a line, not a script file.
    command: z
      .string()
      .trim()
      .min(1, 'A command automation needs a command.')
      .max(4000)
      .refine((value) => !value.includes('\0')),
    timeoutSeconds: z.number().int().min(1).max(3600),
    shell: z.enum(['login', 'plain']),
    report: z.enum(['silent', 'on-output', 'always'])
  })
)

/** What the automation does: launch an agent, or run a command with no agent at all. */
const AutomationActionParam = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('agent') }),
    z.strictObject({ kind: z.literal('command'), script: AutomationScriptParam })
  ])
)

/** A command needs no prompt; an agent automation needs a non-empty one. */
function assertAutomationActionedPrompt(
  value: { prompt?: string; action?: { kind: 'agent' | 'command' } | null },
  ctx: z.RefinementCtx
): void {
  if (value.action?.kind === 'command') {
    return
  }
  if (!value.prompt?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'Missing automation prompt', path: ['prompt'] })
  }
}

export const AutomationCanonicalLaunchSetup = lazyZodSchema(() =>
  z.strictObject({
    surface: z.enum(['chat', 'terminal']).optional(),
    extraAgentArgs: z.string().optional(),
    launchPreferences: ChoicePatch.extend({
      permissionMode: z.enum(AGENT_PERMISSION_CHOICES).optional()
    }).optional(),
    agentArgs: z
      .string()
      .refine((value) => !value.includes('\0'))
      .nullable()
      .optional()
  })
)

export const AutomationLaunchSetupPatch = lazyZodSchema(() =>
  z
    .strictObject({
      surface: z.enum(['chat', 'terminal']).optional(),
      choices: ChoicePatch.optional(),
      arguments: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('legacy-extras'), value: z.string() }),
          z.strictObject({
            kind: z.literal('value'),
            value: z.string().refine((value) => !value.includes('\0'))
          }),
          z.strictObject({ kind: z.literal('empty') }),
          z.strictObject({ kind: z.literal('inherit') })
        ])
        .optional(),
      sources: z
        .strictObject({
          arguments: z
            .discriminatedUnion('kind', [
              z.strictObject({
                kind: z.literal('value'),
                value: z.string().refine((value) => !value.includes('\0'))
              }),
              z.strictObject({ kind: z.literal('empty') }),
              z.strictObject({ kind: z.literal('inherit') })
            ])
            .optional(),
          legacyArguments: z.string().optional(),
          extraAgentArgs: z.string().optional(),
          retiredChoices: z
            .array(
              z
                .string()
                .refine(
                  (key) =>
                    key === 'model' ||
                    key === 'permissionMode' ||
                    (key.startsWith('options.') && OptionKey.safeParse(key.slice(8)).success)
                )
            )
            .optional()
        })
        .optional(),
      copy: AutomationCanonicalLaunchSetup.optional()
    })
    .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
      message: 'Choose an automation launch change.'
    })
)

export const AutomationCreate = lazyZodSchema(() =>
  z
    .object({
      creationKey: OptionalString,
      name: requiredString('Missing automation name'),
      prompt: OptionalString,
      precheck: AutomationPrecheck,
      action: AutomationActionParam.optional(),
      agentId: TuiAgent.nullable().optional(),
      extraAgentArgs: ExtraAgentArgs,
      launchSetupPatch: AutomationLaunchSetupPatch.optional(),
      runContext: WorkspaceRunContext,
      sourceContext: TaskSourceContext,
      bot: AutomationBotTarget.optional(),
      on: AutomationEventTriggers,
      once: AutomationOnceParam,
      repo: OptionalString,
      workspace: OptionalString,
      workspaceMode: AutomationWorkspaceMode,
      baseBranch: OptionalPlainString,
      setupDecision: SetupDecision,
      setupTrustHash: z.string().max(128).optional(),
      reuseSession: OptionalBoolean,
      timezone: OptionalString,
      timezoneExplicit: OptionalBoolean,
      rrule: AutomationSchedule,
      dtstart: requiredNumber('Missing trigger start time'),
      enabled: OptionalBoolean,
      missedRunGraceMinutes: OptionalPositiveInt,
      destination: Destination,
      // The native chat whose agent ran the command, to show the saved automation there.
      callerSessionId: OptionalString,
      // No --runs-in was given: it runs in the calling chat when that is one of the bot's own.
      runsInDefault: z.literal(true).optional(),
      // What a CLI from before runsInDefault sends for a wait given no --runs-in.
      waitInCallerChat: z.literal(true).optional()
    })
    .superRefine(refuseUnknownNamedZone)
    .superRefine(assertAutomationActionedPrompt)
)

export const AutomationUpdateFields = lazyZodSchema(() =>
  z
    .object({
      name: OptionalString,
      prompt: OptionalString,
      precheck: AutomationPrecheck,
      // Null clears back to an agent automation.
      action: AutomationActionParam.nullable().optional(),
      agentId: TuiAgent.nullable().optional(),
      extraAgentArgs: ExtraAgentArgs,
      launchSetupPatch: AutomationLaunchSetupPatch.optional(),
      runContext: WorkspaceRunContext,
      sourceContext: TaskSourceContext,
      bot: AutomationBotTarget.optional(),
      on: AutomationEventTriggers,
      once: AutomationOnceParam,
      repo: OptionalString,
      workspace: OptionalString,
      workspaceMode: AutomationWorkspaceMode,
      // Why: update patches distinguish omitted from null so callers can clear a saved base branch.
      baseBranch: OptionalNullablePlainString,
      setupDecision: SetupDecision,
      setupTrustHash: z.string().max(128).optional(),
      reuseSession: OptionalBoolean,
      timezone: OptionalString,
      timezoneExplicit: OptionalBoolean,
      rrule: AutomationSchedule.optional(),
      dtstart: requiredNumber('Missing trigger start time').optional(),
      enabled: OptionalBoolean,
      missedRunGraceMinutes: OptionalPositiveInt
    })
    .superRefine(refuseUnknownNamedZone)
)

export const AutomationUpdate = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing automation id'),
    updates: AutomationUpdateFields,
    expectedOwner: ExpectedOwner,
    destination: Destination,
    callerSessionId: OptionalString,
    // An edit relying on the current new-per-run mode is refused if the stored mode changed first.
    expectedWorkspaceMode: z.literal('new_per_run').optional()
  })
)
