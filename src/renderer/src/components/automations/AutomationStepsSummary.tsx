/**
 * What an automation does, read-only.
 *
 * Steps are never edited in the UI: the plan is authored by an agent from a
 * description, because a form that could express ordering, timeouts and failure
 * policy would be a worse authoring surface than the conversation that produced
 * it. This component is the other half of that decision — the panel still has to
 * show you exactly what will run, in order, before it runs unattended.
 */

import React from 'react'
import type { Automation } from '../../../../shared/automations-types'
import {
  formatAutomationStepsSummary,
  isAutomationAgentStep,
  resolveAutomationSteps,
  type AutomationStep
} from '../../../../shared/automation-steps'
import { translate } from '@/i18n/i18n'

export const AUTOMATION_STEPS_SUMMARY_SLOT = 'automation-steps-summary'

function scriptMeta(step: Extract<AutomationStep, { kind: 'script' }>): string {
  const onFailure =
    step.onFailure === 'continue'
      ? translate(
          'auto.components.automations.AutomationStepsSummary.onFailureContinue',
          'continues on failure'
        )
      : translate(
          'auto.components.automations.AutomationStepsSummary.onFailureStop',
          'stops on failure'
        )
  return `${onFailure} · ${step.timeoutSeconds}s`
}

export function AutomationStepsSummary({
  automation,
  className
}: {
  automation: Pick<Automation, 'steps' | 'prompt' | 'agentId'>
  className?: string
}): React.JSX.Element {
  const steps = resolveAutomationSteps(automation)
  return (
    <div className={className} data-slot={AUTOMATION_STEPS_SUMMARY_SLOT}>
      <div className="text-2xs font-medium uppercase text-muted-foreground">
        {translate('auto.components.automations.AutomationStepsSummary.heading', 'Steps')}
        {': '}
        {formatAutomationStepsSummary(automation)}
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={step.kind === 'script' ? `script:${step.command}` : `agent:${step.agentId}`}
            className="rounded-md border border-border/70 bg-muted/35 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-2xs font-medium uppercase text-muted-foreground">
                {translate('auto.components.automations.AutomationStepsSummary.stepNumber', 'Step')}{' '}
                {index + 1}
              </span>
              <span className="rounded-sm border border-border/70 px-1.5 py-0.5 text-2xs text-muted-foreground">
                {isAutomationAgentStep(step)
                  ? translate(
                      'auto.components.automations.AutomationStepsSummary.kindAgent',
                      'agent'
                    )
                  : translate(
                      'auto.components.automations.AutomationStepsSummary.kindScript',
                      'script'
                    )}
              </span>
            </div>
            {isAutomationAgentStep(step) ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground">
                {step.prompt}
              </p>
            ) : (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-xs text-foreground">
                {step.command}
              </p>
            )}
            {isAutomationAgentStep(step) ? (
              <p className="mt-1 text-2xs text-muted-foreground">{step.agentId}</p>
            ) : (
              <p className="mt-1 text-2xs text-muted-foreground">{scriptMeta(step)}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
