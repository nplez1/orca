import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'
import { SCHEMA_VERSION } from '../contract-constants'
import type Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { applySchemaMigrationsV13ToV30 } from './migrate-v13-v30'
import { applySchemaMigrationsV2ToV12 } from './migrate-v2-v12'
import { migrateMailboxPointerEnterV33 } from './migrate-mailbox-pointer-enter-v33'
import { migrateRoleMailboxDeliveryV34 } from './migrate-role-mailbox-delivery-v34'
import { migrateV35 } from './migrate-v35'
import { migrateV36 } from './migrate-v36'
import { migrateV37 } from './migrate-v37'
import { migrateV38 } from './migrate-v38'
import { migrateV39 } from './migrate-v39'
import { migrateV40 } from './migrate-v40'
import { DERIVED_DELIVERY_SCHEMA_SQL, migrateV41 } from './migrate-v41'
import { migrateV42 } from './migrate-v42'
import { migrateV43 } from './migrate-v43'
import { DROP_REMOVED_WORK_TRIGGERS_SQL } from '../reset/removed-orchestration-work-store'

// CREATE TABLE IF NOT EXISTS won't alter existing tables; migrate atomically before bumping user_version.

/**
 * A database written by a newer build. Refused rather than migrated: the older build cannot know the
 * newer schema's tables, so running backfills, reconciliations and trigger creation against them
 * would write through assumptions it cannot check, and the newer build would inherit the damage.
 */
export class OrchestrationSchemaNewerThanBuildError extends Error {
  constructor(
    readonly storedVersion: number,
    readonly buildVersion: number
  ) {
    super(
      `Orchestration database has schema ${storedVersion}, newer than this build's ${buildVersion}`
    )
    this.name = 'OrchestrationSchemaNewerThanBuildError'
  }
}

export function assertOrchestrationSchemaNotNewer(db: Database.Database): void {
  const storedVersion = Number(db.pragma('user_version', { simple: true }) ?? 0)
  if (storedVersion > SCHEMA_VERSION) {
    db.close()
    throw new OrchestrationSchemaNewerThanBuildError(storedVersion, SCHEMA_VERSION)
  }
}

export function migrate(this: OrchestrationDb): void {
  assertOrchestrationSchemaNotNewer(this.db)
  const storedVersion = this.db.pragma('user_version', { simple: true }) as number
  const current = resolveOrchestrationMigrationStartVersion(this.db, storedVersion, SCHEMA_VERSION)
  if (current >= SCHEMA_VERSION) {
    return
  }

  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db.exec(
      'DROP TRIGGER IF EXISTS trg_deliveries_one_outstanding; DROP VIEW IF EXISTS outstanding_deliveries;'
    )
    // Why: their bodies name columns a step may drop or rebuild; the open after migrate recreates them.
    this.db.exec(DROP_REMOVED_WORK_TRIGGERS_SQL)
    applySchemaMigrationsV2ToV12.call(this, current)
    applySchemaMigrationsV13ToV30.call(this, current)
    migrateMailboxPointerEnterV33.call(this, current)
    migrateRoleMailboxDeliveryV34.call(this, current)
    migrateV35.call(this, current)
    migrateV36.call(this, current)
    migrateV37.call(this, current)
    migrateV38.call(this, current)
    migrateV39.call(this, current)
    migrateV40.call(this, current)
    // Run v41 after older steps that recreate the unique index.
    migrateV41.call(this, current)
    migrateV42.call(this, current)
    migrateV43.call(this, current)
    this.createMailboxDeliveryIndexesIfPossible()
    // Recreate derived objects after table rebuilds; existing views would prevent RENAME.
    this.db.exec(DERIVED_DELIVERY_SCHEMA_SQL)
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    this.db.exec('COMMIT')
  } catch (err) {
    this.db.exec('ROLLBACK')
    throw err
  }
}

export type SchemaMigrateMethods = {
  migrate: typeof migrate
}

export function attachSchemaMigrate(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    migrate
  })
}
