/**
 * Operation log + idempotency.
 *
 * Every write goes through `withOperation`, which inside a single transaction:
 *   1. reserves the idempotency key (UNIQUE column) — a replay returns the
 *      cached response instead of re-applying the mutation,
 *   2. runs the mutation,
 *   3. refreshes the queue snapshot,
 *   4. records the operation.
 *
 * All four either land together or roll back together.
 */
import type { OperationRecord } from '../../shared/types.ts';
import { displayDemoText } from '../../shared/demo-text.ts';
import {
  escapeLike,
  matchesSearchText,
  normalizeSearchText,
  renderOperationSummaryZh,
} from '../../shared/activity-summary.ts';
import { all, get, run, transaction, type Db, type Row } from '../db/connection.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { refreshQueue, type QueueRefresh } from './queue-service.ts';

export interface OperationInput {
  idempotency_key: string;
  operation_type: string;
  target_type: string;
  actor_id: string;
}

export interface OperationOutcome<T> {
  result: T;
  operation: OperationRecord;
  queue: QueueRefresh;
  replayed: boolean;
}

interface MutationResult<T> {
  result: T;
  target_id: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  /** Skip the queue recalculation for writes that cannot affect ranking. */
  skipQueueRefresh?: boolean;
  /**
   * Re-read the result after the queue refresh. Needed because the mutation
   * runs first, so anything it returns still carries the pre-refresh
   * queue_position/queue_score.
   */
  rehydrate?: (result: T) => T;
}

function hydrateOperation(row: Row, replayed: boolean): OperationRecord {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    operation_type: row.operation_type,
    target_type: row.target_type,
    target_id: row.target_id ?? null,
    actor_id: row.actor_id,
    actor_name: row.actor_name ?? row.actor_id,
    status: row.status,
    summary: row.summary,
    detail: row.detail ? JSON.parse(row.detail) : null,
    replayed,
    created_at: row.created_at,
  };
}

const OPERATION_SELECT = `
  SELECT o.*, a.display_name AS actor_name
  FROM operations o JOIN actors a ON a.id = o.actor_id
`;

/**
 * Filters for the activity timeline. All values are caller-validated (zod) and
 * bound as parameters — the WHERE clause is built from fixed fragments only.
 */
export interface OperationFilter {
  limit?: number;
  /**
   * Free-text search. Whitespace-separated tokens, all of which must match
   * (AND); each token is compared against the task / goal title (stored English
   * or displayed Chinese alias), the summary (raw or rendered into the Chinese
   * the timeline shows) and the operation's `detail` JSON.
   */
  query?: string;
  /** Comma-separated `operation_type` whitelist. */
  type?: string;
  /** Inclusive lower bound on `created_at` (ISO-8601). */
  from?: string;
  /** Inclusive upper bound on `created_at` (ISO-8601). */
  to?: string;
}

export function findOperationByKey(db: Db, key: string): Row | undefined {
  return get<Row>(db, `${OPERATION_SELECT} WHERE o.idempotency_key = ?`, [key]);
}

/**
 * The hydrated operation record for an idempotency key, for callers that ran a
 * mutation through a service (which returns its own result shape) but still owe
 * the HTTP layer the usual `operation` field.
 *
 * `replayed` is left `false`: a caller holding the key cannot tell from the row
 * alone whether this call or an earlier one created it, and the services that
 * need that distinction report it themselves.
 */
export function findOperationRecordByKey(db: Db, key: string): OperationRecord | null {
  const row = findOperationByKey(db, key);
  return row ? hydrateOperation(row, false) : null;
}

/**
 * Ids of operations whose *rendered Chinese* summary contains `needle`.
 *
 * Deliberately a full scan of `operations`: the rendering happens in JS, so SQL
 * cannot filter on it, and scanning only the first page would silently hide
 * older matches. The activity log is a single-user local file, so the scan is
 * cheap; it reads nothing but the three columns the renderer takes.
 */
function matchRenderedSummaries(db: Db, needle: string): string[] {
  const hits: string[] = [];
  const rows = all<Row>(db, 'SELECT id, summary, operation_type, target_type FROM operations');
  for (const row of rows) {
    const rendered = renderOperationSummaryZh({
      summary: row.summary == null ? null : String(row.summary),
      operation_type: String(row.operation_type),
      target_type: String(row.target_type),
    });
    if (matchesSearchText(rendered, needle)) hits.push(String(row.id));
  }
  return hits;
}

/**
 * The search terms in a free-text query: split on whitespace, blanks dropped,
 * duplicates collapsed.
 *
 * Chinese needs no segmentation — a substring *is* a full-text match there — so
 * a single CJK run stays one token and matches as a substring. Splitting only on
 * whitespace is what lets a user type two independent terms ("关键词A 关键词B")
 * and get the intersection.
 */
function searchTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const part of normalizeSearchText(query).split(/\s+/)) {
    if (part) seen.add(part);
  }
  return [...seen];
}

/**
 * One token's WHERE fragment: the token must appear *somewhere* on the row.
 *
 * "Somewhere" is an OR over the stored text (joined task/goal title, summary,
 * detail), plus two id whitelists resolved in JS — the Chinese alias of a demo
 * title, and the rendered Chinese summary. Appends its own bound values to
 * `params` in placeholder order.
 *
 * The title, summary and detail are separate LIKE clauses rather than one
 * `COALESCE(t.title, g.title, o.summary, o.detail)`: COALESCE stops at the first
 * non-null, so a joined title would hide the stored summary and detail for every
 * task/goal-targeted row — "Changed quadrant" would stop matching the moment a
 * title joined.
 */
function tokenClause(db: Db, token: string, params: (string | number)[]): string {
  // The stored title stays English, while the UI renders the Chinese alias from
  // DEMO_TEXT. Searching the displayed text must work too, so resolve the alias
  // in JS and translate the hits into an id whitelist — the stored rows are
  // never rewritten.
  const taskIds: string[] = [];
  const goalIds: string[] = [];
  for (const row of all<Row>(db, 'SELECT id, title, is_demo FROM tasks')) {
    const alias = displayDemoText(String(row.title), Number(row.is_demo) === 1);
    if (matchesSearchText(alias, token)) taskIds.push(String(row.id));
  }
  for (const row of all<Row>(db, 'SELECT id, title, is_demo FROM goals')) {
    const alias = displayDemoText(String(row.title), Number(row.is_demo) === 1);
    if (matchesSearchText(alias, token)) goalIds.push(String(row.id));
  }

  // The summary is stored in English but shown in Chinese ("Changed quadrant of
  // ... to q2" → "将「…」的象限改为重要不紧急"), so a user searching the text they
  // can actually see needs the rendered form compared. Render every operation —
  // not the already-LIMITed page — so the search covers the whole log, then pass
  // the hits down as a bound id whitelist.
  const summaryIds = matchRenderedSummaries(db, token);

  const likeNeedle = `%${escapeLike(token)}%`;
  const clauses = [
    `LOWER(COALESCE(t.title, g.title)) LIKE ? ESCAPE '\\'`,
    `LOWER(o.summary) LIKE ? ESCAPE '\\'`,
    // `detail` is the mutation's JSON payload. JSON.stringify leaves non-ASCII
    // as-is, so Chinese written into it is matchable without any unescaping.
    `LOWER(COALESCE(o.detail, '')) LIKE ? ESCAPE '\\'`,
  ];
  params.push(likeNeedle, likeNeedle, likeNeedle);
  if (taskIds.length) {
    clauses.push(`(o.target_type = 'task' AND o.target_id IN (${taskIds.map(() => '?').join(', ')}))`);
    params.push(...taskIds);
  }
  if (goalIds.length) {
    clauses.push(`(o.target_type = 'goal' AND o.target_id IN (${goalIds.map(() => '?').join(', ')}))`);
    params.push(...goalIds);
  }
  if (summaryIds.length) {
    clauses.push(`o.id IN (${summaryIds.map(() => '?').join(', ')})`);
    params.push(...summaryIds);
  }
  return `(${clauses.join(' OR ')})`;
}

export function listOperations(db: Db, filter: OperationFilter = {}): OperationRecord[] {
  const limit = filter.limit ?? 100;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.query) {
    // Tasks and goals are joined by (target_type, target_id) so the search can
    // reach their titles; the summary and detail are matched alongside, both raw
    // and rendered.
    //
    // Every token must hit (AND) — typing a second term narrows the result set
    // rather than widening it, which is what makes a two-word query useful. A
    // single-token query therefore behaves exactly as it did before.
    for (const token of searchTokens(filter.query)) {
      where.push(tokenClause(db, token, params));
    }
  }
  if (filter.type) {
    const types = filter.type
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (types.length) {
      where.push(`o.operation_type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
  }
  if (filter.from) {
    where.push('o.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('o.created_at <= ?');
    params.push(filter.to);
  }

  const sql = `${OPERATION_SELECT}
    LEFT JOIN tasks t ON o.target_type = 'task' AND t.id = o.target_id
    LEFT JOIN goals g ON o.target_type = 'goal' AND g.id = o.target_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?`;

  return all<Row>(db, sql, [...params, limit]).map((row) => hydrateOperation(row, false));
}

/**
 * Runs `mutate` exactly once per idempotency key.
 *
 * A replayed key short-circuits to the stored response, so clients can retry a
 * dropped request without creating a duplicate task or stealing a claim.
 */
export function withOperation<T>(
  db: Db,
  input: OperationInput,
  mutate: () => MutationResult<T>,
): OperationOutcome<T> {
  const existing = findOperationByKey(db, input.idempotency_key);
  if (existing) {
    return {
      result: existing.response ? (JSON.parse(existing.response) as T) : (null as T),
      operation: hydrateOperation(existing, true),
      queue: { snapshot: null, entries: [] },
      replayed: true,
    };
  }

  return transaction(db, () => {
    // Reserve the key first: a concurrent request with the same key hits the
    // UNIQUE constraint and aborts rather than applying the mutation twice.
    const operationId = newId('op');
    const createdAt = nowIso();
    run(
      db,
      `INSERT INTO operations
         (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, detail, response, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'succeeded', '', NULL, NULL, ?)`,
      [
        operationId,
        input.idempotency_key,
        input.operation_type,
        input.target_type,
        input.actor_id,
        createdAt,
      ],
    );

    const mutation = mutate();

    const queue = mutation.skipQueueRefresh
      ? { snapshot: null, entries: [] }
      : refreshQueue(db, `${input.operation_type}`);

    // The queue refresh assigns position/score, so re-read the result now that
    // the snapshot exists — otherwise callers see stale nulls.
    const finalResult = mutation.rehydrate ? mutation.rehydrate(mutation.result) : mutation.result;

    run(
      db,
      `UPDATE operations
          SET target_id = ?, summary = ?, detail = ?, response = ?
        WHERE id = ?`,
      [
        mutation.target_id,
        mutation.summary,
        mutation.detail ? JSON.stringify(mutation.detail) : null,
        JSON.stringify(finalResult ?? null),
        operationId,
      ],
    );

    const operation = hydrateOperation(findOperationByKey(db, input.idempotency_key)!, false);
    return { result: finalResult, operation, queue, replayed: false };
  });
}

/** Records a failed attempt so the activity log shows rejected operations too. */
export function logFailure(
  db: Db,
  input: OperationInput,
  targetId: string | null,
  summary: string,
  detail?: Record<string, unknown>,
): void {
  if (findOperationByKey(db, input.idempotency_key)) return;
  run(
    db,
    `INSERT INTO operations
       (id, idempotency_key, operation_type, target_type, target_id, actor_id, status, summary, detail, response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, NULL, ?)`,
    [
      newId('op'),
      input.idempotency_key,
      input.operation_type,
      input.target_type,
      targetId,
      input.actor_id,
      summary,
      detail ? JSON.stringify(detail) : null,
      nowIso(),
    ],
  );
}
