import * as z from 'zod'
import { validateAutomationSteps } from '../../automations/steps/automation-steps'

/** Refused at parse time with the step error's message, so a shell body never reaches a store. */
export const AutomationSteps = z
  .unknown()
  .transform((value, ctx) => {
    if (value === undefined || value === null) {
      return value === null ? null : undefined
    }
    const parsed = validateAutomationSteps(value)
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.error })
      return z.NEVER
    }
    return parsed.steps
  })
  .optional()
