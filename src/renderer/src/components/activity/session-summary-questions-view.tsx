import React from 'react'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { CommentComposer } from '@/components/comment-composer'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'
import {
  SESSION_SUMMARY_ASK_ERRORS,
  SESSION_SUMMARY_QUESTION_MAX_LENGTH,
  type SessionSummaryQuestion
} from '../../../../shared/session-summary-types'

const CLOCK = { hour: 'numeric', minute: '2-digit' } as const

function askedAtLabel(askedAt: number): string {
  return uiDateTimeFormat(CLOCK).format(askedAt)
}

/** The Questions disclosure's one-line detail, e.g. "3 questions · last asked 12:04". */
export function sessionSummaryQuestionsDetail(
  questions: readonly SessionSummaryQuestion[]
): string {
  const last = questions.at(-1)
  return translate(
    'activity.sessionSummary.askDetail',
    '{{count}} questions · last asked {{time}}',
    {
      count: questions.length,
      time: last ? askedAtLabel(last.askedAt) : '',
      defaultValue_one: '{{count}} question · last asked {{time}}'
    }
  )
}

/** Electron's wrapper around an error a main-process handler threw. */
const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/

/**
 * What a failed row says. Main writes codes, not sentences, so they are translated here; anything
 * else is the agent's own message, shown under a translated lead rather than as the whole text.
 */
export function sessionSummaryAskErrorText(
  t: Translate,
  error: string | undefined
): { message: string; detail?: string } {
  const code = (error ?? '').replace(REMOTE_METHOD_PREFIX, '')
  switch (code) {
    case SESSION_SUMMARY_ASK_ERRORS.interrupted:
      return {
        message: t(
          'activity.sessionSummary.askInterrupted',
          'Orca quit before this question was answered.'
        )
      }
    case SESSION_SUMMARY_ASK_ERRORS.emptyAnswer:
      return {
        message: t('activity.sessionSummary.askEmptyAnswer', 'The summary agent gave no answer.')
      }
    case SESSION_SUMMARY_ASK_ERRORS.timedOut:
      return {
        message: t(
          'activity.sessionSummary.askTimedOut',
          'The summary agent took too long to answer.'
        )
      }
    case SESSION_SUMMARY_ASK_ERRORS.busy:
      return {
        message: t(
          'activity.sessionSummary.askBusy',
          'Two questions are still being answered. Ask again once one finishes.'
        )
      }
    case SESSION_SUMMARY_ASK_ERRORS.noSummary:
      return { message: askNeedsBriefText(t) }
    case SESSION_SUMMARY_ASK_ERRORS.pairedHost:
      return { message: askUnavailableHostText(t) }
    default:
      return {
        message: t('activity.sessionSummary.askFailed', 'Could not answer this question.'),
        ...(code ? { detail: code } : {})
      }
  }
}

function askNeedsBriefText(t: Translate): string {
  return t(
    'activity.sessionSummary.askNeedsBrief',
    'Questions open once this session has a summary.'
  )
}

function askUnavailableHostText(t: Translate): string {
  return t(
    'activity.sessionSummary.askUnavailableHost',
    'Questions are not available for sessions on a paired host yet.'
  )
}

function QuestionStatus({
  question,
  onRetry
}: {
  question: SessionSummaryQuestion
  onRetry?: (question: SessionSummaryQuestion) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (question.status === 'pending') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoadingSpinner className="size-3" />
        {t('activity.sessionSummary.askPending', 'Answering…')}
      </p>
    )
  }
  if (question.status === 'answered') {
    return (
      <p className="whitespace-pre-line break-words text-xs leading-relaxed text-foreground">
        {question.answer}
      </p>
    )
  }
  const failure = sessionSummaryAskErrorText(t, question.error)
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 break-words text-xs">
        <p className="text-destructive">{failure.message}</p>
        {failure.detail ? <p className="mt-0.5 text-muted-foreground">{failure.detail}</p> : null}
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={() => onRetry(question)}
        >
          <RotateCw aria-hidden="true" />
          {t('activity.sessionSummary.askRetry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}

function QuestionRow({
  question,
  onRetry
}: {
  question: SessionSummaryQuestion
  onRetry?: (question: SessionSummaryQuestion) => void
}): React.JSX.Element {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline gap-2">
        {/* Markdown, because the composer it was typed into formats as Markdown. */}
        <CommentMarkdown
          content={question.text}
          className="min-w-0 flex-1 break-words text-xs font-medium leading-relaxed text-foreground [&_pre]:max-w-full"
        />
        <time
          dateTime={new Date(question.askedAt).toISOString()}
          className="shrink-0 text-2xs text-muted-foreground"
        >
          {askedAtLabel(question.askedAt)}
        </time>
      </div>
      {/* Polite: the answer lands long after the reader moved on, and must not interrupt them. */}
      <div aria-live="polite">
        <QuestionStatus question={question} {...(onRetry ? { onRetry } : {})} />
      </div>
    </li>
  )
}

/** The reader's questions, oldest first, each with its time and its answer under it. */
export function SessionSummaryQuestionList({
  questions,
  onRetry
}: {
  questions: readonly SessionSummaryQuestion[]
  onRetry?: (question: SessionSummaryQuestion) => void
}): React.JSX.Element {
  const lastRowRef = React.useRef<HTMLLIElement | null>(null)
  const shownCountRef = React.useRef(questions.length)
  // Why only on growth: a question just sent must be visible without scrolling, but opening the
  // pane on an old list must not jump the reader away from the brief.
  React.useEffect(() => {
    if (questions.length > shownCountRef.current) {
      lastRowRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: motionSafeScrollBehavior()
      })
    }
    shownCountRef.current = questions.length
  }, [questions.length])

  return (
    <ol className="space-y-3">
      {questions.map((question) => (
        <QuestionRow key={question.id} question={question} {...(onRetry ? { onRetry } : {})} />
      ))}
      <li ref={lastRowRef} aria-hidden="true" className="h-0" />
    </ol>
  )
}

/**
 * The composer pinned under the pane's scroll area.
 *
 * Why the shared comment composer: it is the input the PR and Jira panels use, so the send
 * affordance and the submit shortcut match every other place the reader types a reply.
 */
export function SessionSummaryQuestionComposer({
  canAsk,
  hasBrief,
  onAsk
}: {
  canAsk: boolean
  /** Whether a brief is on screen, which is what decides the disabled reason. */
  hasBrief: boolean
  onAsk: (text: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = React.useState('')
  const trimmed = draft.trim()
  const tooLong = trimmed.length > SESSION_SUMMARY_QUESTION_MAX_LENGTH
  const submit = (): void => {
    if (!canAsk || !trimmed || tooLong) {
      return
    }
    onAsk(trimmed)
    setDraft('')
  }
  const disabledReason = canAsk
    ? undefined
    : hasBrief
      ? askUnavailableHostText(t)
      : askNeedsBriefText(t)
  return (
    <div className="shrink-0 border-t border-border bg-background px-3 py-3">
      <CommentComposer
        value={draft}
        onValueChange={setDraft}
        onSubmit={submit}
        placeholder={t('activity.sessionSummary.askPlaceholder', 'Ask about this session…')}
        submitLabel={t('activity.sessionSummary.askSubmit', 'Ask')}
        canSubmit={canAsk && trimmed.length > 0 && !tooLong}
        disabled={!canAsk}
        {...(disabledReason ? { disabledReason } : {})}
      />
      {/* Why inline as well: the composer names the reason only in its send button's tooltip. */}
      {disabledReason || tooLong ? (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          {tooLong
            ? t(
                'activity.sessionSummary.askTooLong',
                'Questions are limited to {{max}} characters.',
                { max: SESSION_SUMMARY_QUESTION_MAX_LENGTH }
              )
            : disabledReason}
        </p>
      ) : null}
    </div>
  )
}
