import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface Migration {
  /** Position in the sequence, starting at 1. Matches the file's number. */
  readonly version: number;
  readonly name: string;
  /** Statements run inside one transaction. No BEGIN or COMMIT of its own. */
  readonly sql: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

function checksumOf(migration: Migration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

/**
 * Brings the database up to the last migration in the list. Safe to call on
 * every open and from several processes at once: the whole run holds the
 * write lock, and an already applied migration is only verified.
 */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[],
): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration "${migration.name}" has version ${migration.version} but sits at position ${index + 1}. Versions are contiguous and start at 1.`,
      );
    }
  });

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT
    `);
    const applied = db
      .prepare<[], AppliedMigration>(
        "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
      )
      .all();

    for (const row of applied) {
      const migration = migrations[row.version - 1];
      if (migration === undefined) {
        throw new Error(
          `The database is at migration ${row.version} ("${row.name}"), which this code does not know. It was written by a newer version of the code.`,
        );
      }
      if (checksumOf(migration) !== row.checksum) {
        throw new Error(
          `Migration ${row.version} ("${row.name}") changed after it was applied to this database. Applied migrations are immutable: restore its SQL and put the change in a new migration.`,
        );
      }
    }

    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of migrations.slice(applied.length)) {
      db.exec(migration.sql);
      record.run(
        migration.version,
        migration.name,
        checksumOf(migration),
        Date.now(),
      );
    }
  });
  run.immediate();
}
