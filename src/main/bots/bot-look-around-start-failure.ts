// A look that could not start records why when the agent CLI is the reason: a Pi below the
// tool-limited minimum fails every look, and ten in a row turn Look around off, so "couldn't start"
// ten times leaves its owner nothing to act on. Fork-owned so the upstream runner keeps one line.
import {
  agentCliTooOldWords,
  sayAgentSessionFailureEnglish
} from '../../shared/agent-session/failures/agent-session-failure-copy'
import { agentCliInstallationProblemOf } from '../native-chat/agent-launch/agent-cli-installation-error'

/** The recorded failure for a look that could not start: the generic line, or that line and the cause. */
export function lookStartFailureWords(error: unknown, couldNotStart: string): string {
  const problem = agentCliInstallationProblemOf(error)
  if (!problem) {
    return couldNotStart
  }
  return `${couldNotStart} ${agentCliTooOldWords(problem, sayAgentSessionFailureEnglish)}`
}
