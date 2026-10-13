import { redactEphemeralVmRecipeDiagnosticText } from '../shared/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmRecipeDoctorResult } from '../shared/ephemeral-vm-recipes'

/** Rendering and transcript capping for `orca vm recipe doctor`'s output. */

export type ProvisionStageTranscript = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  parseError?: string
}

export type ProvisionTranscript = {
  provision: ProvisionStageTranscript
  destroy?: ProvisionStageTranscript
}

export type DoctorResult = EphemeralVmRecipeDoctorResult & {
  provisionTranscript?: ProvisionTranscript
}

const MAX_TRANSCRIPT_STREAM_BYTES = 16_000

// Why: keep both ends of a long log — the script's setup context (head) and the
// failure itself (tail) — rather than only the last 500 chars.
export function capTranscriptStream(value: string): string {
  const redacted = redactEphemeralVmRecipeDiagnosticText(value)
  if (redacted.length <= MAX_TRANSCRIPT_STREAM_BYTES) {
    return redacted
  }
  const half = Math.floor(MAX_TRANSCRIPT_STREAM_BYTES / 2)
  const omitted = redacted.length - half * 2
  return `${redacted.slice(0, half)}\n…[${omitted} chars omitted]…\n${redacted.slice(-half)}`
}

export function buildProvisionFailureRemediation(stderr: string, stdout: string): string {
  const redactedStderr = redactEphemeralVmRecipeDiagnosticText(stderr).trim()
  const redactedStdout = redactEphemeralVmRecipeDiagnosticText(stdout).trim()
  const detail = redactedStderr || redactedStdout
  return detail
    ? `Check recipe output. Last captured output: ${detail.slice(-500)}`
    : 'Check recipe stderr and ensure stdout contains the VM recipe result JSON.'
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines = [
    `recipe: ${result.recipeId}`,
    `repoPath: ${result.repoPath}`,
    `ok: ${result.ok}`,
    ...result.checks.map((check) => {
      const suffix = check.remediation ? `\n  next: ${check.remediation}` : ''
      return `${check.status.toUpperCase()} ${check.id}: ${check.message}${suffix}`
    })
  ]
  if (result.provisionTranscript) {
    lines.push(...formatTranscriptStage('create', result.provisionTranscript.provision))
    if (result.provisionTranscript.destroy) {
      lines.push(...formatTranscriptStage('destroy', result.provisionTranscript.destroy))
    }
  }
  return lines.join('\n')
}

function formatTranscriptStage(label: string, stage: ProvisionStageTranscript): string[] {
  const out = [`--- ${label} (exit ${stage.exitCode ?? stage.signal ?? 'unknown'}) ---`]
  if (stage.parseError) {
    out.push(`parseError: ${stage.parseError}`)
  }
  if (stage.stdout.trim()) {
    out.push(`stdout:\n${stage.stdout}`)
  }
  if (stage.stderr.trim()) {
    out.push(`stderr:\n${stage.stderr}`)
  }
  return out
}
