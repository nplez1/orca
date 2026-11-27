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
import { lazyZodSchema } from '../schema/lazy-zod-schema'

const SessionSummaryPaneParams = lazyZodSchema(() =>
  z.object({
    paneKey: z.string().min(1).max(512)
  })
)

/** Loose on the wire; `parseSessionSummaryFoldParams` narrows it on the host. */
const SessionSummaryFoldParamsOnWire = lazyZodSchema(() =>
  z.record(z.string(), z.unknown()).nullish()
)

/** Loose on the wire too; `parseSessionSummarySessionRef` narrows it on the host. */
const SessionSummarySessionOnWire = lazyZodSchema(() => z.record(z.string(), z.unknown()).nullish())

export const SessionSummaryOpenOnHostParams = lazyZodSchema(() =>
  SessionSummaryPaneParams.extend({
    foldParams: SessionSummaryFoldParamsOnWire,
    /** Which session the viewer has on screen, when the host's own row cannot say. */
    session: SessionSummarySessionOnWire,
    /**
     * The host the viewer believes owns the session.
     *
     * Why forwarded: a browser client can read a workspace owned by a *third* host, and the host
     * it is paired with holds no status row for that pane — so without this the fold would run
     * where the session is not.
     */
    executionHostId: z.string().min(1).max(512).nullish(),
    /** The reader's freshness window; the host owns the brief cache this decides about. */
    revalidateWithinMs: z.number().int().nonnegative().nullish(),
    /** This client already holds the pane's lease there — a refresh, not a new viewer. */
    sameViewer: z.boolean().nullish()
  })
)

export const SessionSummarySnapshotOnHostParams = SessionSummaryPaneParams

export const SessionSummaryCloseOnHostParams = lazyZodSchema(() =>
  SessionSummaryPaneParams.extend({
    seenTimelineCount: z.number().int().nonnegative()
  })
)
