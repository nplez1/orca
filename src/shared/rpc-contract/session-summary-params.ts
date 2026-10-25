// Wire contract for a fold that runs on the host that owns the session.
//
// A paired Orca server is the same codebase (see `orcad-entry.ts`), so it can run the
// same `SessionSummaryService` the desktop runs: it has the hook rows, the transcript
// on its own disk, and the agent CLI. Accessing a session remotely therefore folds it
// exactly where working on that machine directly would — the desktop only subscribes.
//
// The fold's agent/model travel with the request (`foldParams`), resolved from the
// requesting client's Settings → Agents, so a host never picks an agent the user did
// not choose. SSH targets have no such server and take the fetch-and-fold-locally
// path instead.
import { z } from 'zod'

const SessionSummaryPaneParams = z.object({
  paneKey: z.string().min(1).max(512)
})

/** Loose on the wire; `parseSessionSummaryFoldParams` narrows it on the host. */
const SessionSummaryFoldParamsOnWire = z.record(z.string(), z.unknown()).nullish()

/** Loose on the wire too; `parseSessionSummarySessionRef` narrows it on the host. */
const SessionSummarySessionOnWire = z.record(z.string(), z.unknown()).nullish()

export const SessionSummaryOpenOnHostParams = SessionSummaryPaneParams.extend({
  foldParams: SessionSummaryFoldParamsOnWire,
  /** Which session the viewer has on screen, when the host's own row cannot say. */
  session: SessionSummarySessionOnWire,
  /** The reader's freshness window; the host owns the brief cache this decides about. */
  revalidateWithinMs: z.number().int().nonnegative().nullish()
})

export const SessionSummarySnapshotOnHostParams = SessionSummaryPaneParams

export const SessionSummaryCloseOnHostParams = SessionSummaryPaneParams.extend({
  seenTimelineCount: z.number().int().nonnegative()
})
