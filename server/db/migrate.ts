/**
 * One-command database setup: `npm run db:setup`.
 *
 * Creates data/work-queue.db, applies the schema, ensures the habit files exist
 * and seeds demo content on a fresh database. Safe to re-run.
 */
import { DB_PATH, HABITS_DIR } from '../config.ts';
import { applySchema, openDatabase } from './connection.ts';
import { seed } from './seed.ts';

const db = openDatabase();
applySchema(db);
db.exec("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '1')");

const summary = seed(db);
db.close();

console.log(`[pwq] database ready at ${DB_PATH}`);
console.log(`[pwq] habit files in ${HABITS_DIR}`);
console.log(
  summary.skipped
    ? '[pwq] existing tasks found — demo seed skipped'
    : `[pwq] seeded ${summary.goals} demo goals and ${summary.tasks} demo tasks`,
);
