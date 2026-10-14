/**
 * SQLite access built on Node's built-in `node:sqlite` (no native compilation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, SCHEMA_PATH } from '../config.ts';
import { runMigrations } from './migrations.ts';

export type Db = DatabaseSync;

export type SqlParam = string | number | null | bigint | Uint8Array;
export type Row = Record<string, any>;

let instance: Db | null = null;

/** Applies the schema; safe to call repeatedly (every statement is IF NOT EXISTS). */
export function applySchema(db: Db): void {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // Databases created before a column existed need the explicit ALTER path.
  runMigrations(db);
}

export function openDatabase(dbPath: string = DB_PATH): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 4000');
  return db;
}

/** Process-wide handle used by the HTTP layer. */
export function getDb(): Db {
  if (!instance) {
    instance = openDatabase();
    applySchema(instance);
  }
  return instance;
}

export function setDb(db: Db): void {
  instance = db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export function all<T = Row>(db: Db, sql: string, params: SqlParam[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Row>(db: Db, sql: string, params: SqlParam[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, params: SqlParam[] = []): void {
  db.prepare(sql).run(...params);
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Create/update + queue refresh +
 * operation log all go through here so a failure anywhere rolls back the whole
 * unit of work.
 */
const transactionDepth = new WeakMap<Db, number>();

export function transaction<T>(db: Db, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = `princeq_nested_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
      if (depth) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // Already rolled back by SQLite (e.g. statement-level abort).
    }
    throw error;
  } finally {
    if (depth) transactionDepth.set(db, depth);
    else transactionDepth.delete(db);
  }
}

export const toBool = (value: unknown): boolean => value === 1 || value === true || value === 1n;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
