import { getWorkerTerminalAutoReleaseScheduler } from '../terminal-authority/release/worker-terminal-auto-release-scheduler'
import { OrchestrationDb } from './orchestration-db'
import { OrchestrationSchemaNewerThanBuildError } from './schema/migrate'
import { committedHandBackTypes, type MailHandBack } from './messages/helper-mailbox-hand-back'
import { existsSync } from 'node:fs'
import { OrcaRuntimeWithAutomationApiOperations } from '../../workspaces/persisted-surfaces/automation-api-operations'

export abstract class RuntimeOrchestrationDatabaseAccess extends OrcaRuntimeWithAutomationApiOperations {
  abstract ensureOrchestrationFederationRelay(runId?: string): void

  protected abstract scheduleRestoredMessageRepoints(): void

  /** Mail a worker left unread when it reported before a restart still continues it. */
  protected abstract continueRestoredWorkerMail(db: OrchestrationDb): void

  // Defer until userData is final; tests can inject an in-memory DB.
  getOrchestrationDb(): OrchestrationDb {
    // Why the refusal is remembered: this is called from background reconcilers as well as handlers, and
    // reopening a data directory this build refuses would retry pragmas and DDL on every one of them.
    if (this._orchestrationDbRefusal) {
      throw this._orchestrationDbRefusal
    }
    if (!this._orchestrationDb) {
      try {
        this._orchestrationDb = new OrchestrationDb(this.orchestrationDbPath())
      } catch (error) {
        // Why only the schema refusal is remembered: a transient failure (a busy file, a permission that
        // clears) should be retried by the next caller, while a schema this build is too old for never
        // stops being one.
        if (error instanceof OrchestrationSchemaNewerThanBuildError) {
          this._orchestrationDbRefusal = error
        }
        throw error
      }
      this.bindMailHandBack(this._orchestrationDb)
      this.bindCrewChanges(this._orchestrationDb)
      this.ensureOrchestrationFederationRelay()
      this.scheduleRestoredMessageRepoints()
      this.bindWorkerTerminalAutoRelease(this._orchestrationDb)
      // Recover deadlines armed before a restart.
      getWorkerTerminalAutoReleaseScheduler(this).rearm()
      this.continueRestoredWorkerMail(this._orchestrationDb)
    }
    return this._orchestrationDb
  }

  /** The database, opened only if it already exists: a profile without one has no mail to redrive. */
  getExistingOrchestrationDb(): OrchestrationDb | null {
    return this._orchestrationDb || existsSync(this.orchestrationDbPath())
      ? this.getOrchestrationDb()
      : null
  }

  setOrchestrationDb(db: OrchestrationDb): void {
    this.orchestrationFederation.resetForDatabaseChange()
    this.mailPointerRepointScheduler.clear()
    this._orchestrationDb = db
    this._orchestrationDbRefusal = null
    this.bindMailHandBack(db)
    this.bindCrewChanges(db)
    this.ensureOrchestrationFederationRelay()
    this.scheduleRestoredMessageRepoints()
    this.bindWorkerTerminalAutoRelease(db)
  }

  private bindMailHandBack(db: OrchestrationDb): void {
    db.mailHandBackListener = (handBack) => this.offerHandedBackMail(db, handBack)
  }

  /** Wakes the Run for helper mail its creator's settlement moved there, once that committed. */
  private offerHandedBackMail(db: OrchestrationDb, handBack: MailHandBack): void {
    // A replaced database's consumers belong to another runtime.
    if (this._orchestrationDb !== db) {
      return
    }
    try {
      if (db.db.isTransaction) {
        this.mailPointerRepointScheduler.schedule(handBack.mailbox)
        return
      }
      // Re-read committed rows so rolled-back settlements wake nobody.
      for (const type of committedHandBackTypes(db, handBack)) {
        this.notifyMessageArrived(handBack.mailbox, type)
      }
    } catch (error) {
      console.warn('[orchestration] failed to offer handed-back helper mail', error)
      this.mailPointerRepointScheduler.schedule(handBack.mailbox)
    }
  }
}
