import { translate } from '@/i18n/i18n'
import type { GitHubRerunPRChecksResult, PRCheckDetail } from '../../../shared/github/check-types'
import { selectRerunTargets } from '../../../shared/jenkins-rebuild'
import { rebuildJenkinsCheck } from '@/runtime/jenkins-rebuild-client'

/**
 * One "Rerun" action over a failure list that can contain both GitHub Actions checks and Jenkins
 * builds.
 *
 * Why the split happens here rather than in the main process: a Jenkins check carries no run
 * identifier, only a link, so the GitHub half has no way to know it should stay silent about the
 * Jenkins one — which is what produced "No failed GitHub Actions checks to rerun." on a list whose
 * only failure was a Jenkins job.
 */
export type RerunChecksOutcome = {
  ok: boolean
  message: string
  /** How many reruns actually started, so the caller knows whether refreshing is worth it. */
  started: number
}

function plural(count: number, one: string, other: string): string {
  return count === 1 ? one : other
}

export async function rerunChecksAcrossProviders({
  checks,
  failedOnly,
  rerunGitHub
}: {
  checks: PRCheckDetail[]
  failedOnly: boolean
  /** Invoked only when GitHub has a candidate, so a Jenkins-only list never asks GitHub. */
  rerunGitHub: () => Promise<GitHubRerunPRChecksResult>
}): Promise<RerunChecksOutcome> {
  const targets = selectRerunTargets({ checks, failedOnly })
  if (targets.github.length === 0 && targets.jenkins.length === 0) {
    return {
      ok: false,
      started: 0,
      message: failedOnly
        ? translate('prChecks.rerun.nothingFailed', 'No failed checks to rerun.')
        : translate('prChecks.rerun.nothingRerunnable', 'No rerunnable checks found.')
    }
  }

  const errors: string[] = []
  let githubStarted = 0
  if (targets.github.length > 0) {
    // Why try/catch per leg: a runtime RPC that times out throws, and letting that escape would
    // skip the Jenkins builds entirely and drop the count of what already started — which is the
    // one thing a retry must not be given by accident.
    try {
      const result = await rerunGitHub()
      if (result.ok) {
        githubStarted = result.count
      } else {
        errors.push(result.error)
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  // Why sequential: a failed matrix typically names two or three Jenkins builds, and Jenkins is
  // routinely a single build server — a parallel burst would queue behind itself on the same node.
  let jenkinsStarted = 0
  const jenkinsMessages: string[] = []
  for (const check of targets.jenkins) {
    try {
      const outcome = await rebuildJenkinsCheck(check)
      if (outcome.ok) {
        jenkinsStarted += 1
        jenkinsMessages.push(outcome.message)
      } else {
        errors.push(`${check.name}: ${outcome.error}`)
      }
    } catch (error) {
      errors.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const started = githubStarted + jenkinsStarted
  if (errors.length > 0) {
    const detail = errors.join(' ')
    return {
      ok: false,
      started,
      // Why say it: a rerun POST is not idempotent, so a partial success has to be reported before
      // the user retries and starts the successful legs a second time.
      message:
        started > 0
          ? translate(
              'prChecks.rerun.partialFailure',
              '{{value0}} rerun(s) already started. {{value1}}',
              { value0: started, value1: detail }
            )
          : detail
    }
  }

  if (githubStarted > 0 && jenkinsStarted > 0) {
    return {
      ok: true,
      started,
      message: translate(
        'prChecks.rerun.mixedStarted',
        'Reruns requested: {{value0}} GitHub check(s), {{value1}} Jenkins build(s)',
        { value0: githubStarted, value1: jenkinsStarted }
      )
    }
  }
  if (jenkinsStarted > 0) {
    return {
      ok: true,
      started,
      message:
        jenkinsStarted === 1
          ? (jenkinsMessages[0] ?? '')
          : translate(
              'prChecks.rerun.jenkinsStarted',
              'Reruns requested for {{value0}} Jenkins builds',
              { value0: jenkinsStarted }
            )
    }
  }
  return {
    ok: true,
    started,
    message: plural(
      githubStarted,
      translate('prChecks.rerun.githubStarted', 'Check rerun requested'),
      translate('prChecks.rerun.githubStartedPlural', 'Check reruns requested')
    )
  }
}
