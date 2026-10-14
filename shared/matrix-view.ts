/**
 * Pure helpers behind the two-dimensional Eisenhower view (`/matrix`).
 *
 * Everything here is deterministic and free of DOM/React/ECharts imports so the
 * numbering, clustering and statistics can be unit-tested directly:
 *
 * - stable short codes derived from the task id (never from queue position),
 * - resolution of the continuous 0..100 matrix scores with a legacy fallback,
 * - screen-distance clustering that never merges across a quadrant boundary,
 * - per-quadrant counts and shares over an explicit denominator.
 *
 * The server owns the scoring itself; this module only reads what it wrote.
 */
import type { MatrixScoreSource, Quadrant, TaskStatus } from './types.ts';
import { MATRIX_HIGH_THRESHOLD, MATRIX_SCORE_MAX, MATRIX_SCORE_MIN } from './types.ts';

/**
 * The continuous scoring columns. They are being added to `tasks` by the
 * server; declaring them as an optional intersection here keeps this module
 * compiling against both the current and the extended `Task` shape.
 */
export interface MatrixScoreFields {
  matrix_importance_score: number | null;
  matrix_urgency_score: number | null;
  matrix_score_source: MatrixScoreSource | null;
  matrix_score_reason: string | null;
  matrix_score_confidence: number | null;
  matrix_score_version: number | null;
}

/** The minimum a task has to look like for this module to place it. */
export interface MatrixTaskLike extends Partial<MatrixScoreFields> {
  id: string;
  /** Legacy 1..5 integers, kept for backwards compatibility. */
  importance?: number | null;
  urgency?: number | null;
  quadrant?: Quadrant | null;
}

/** Where a placed task's coordinates came from. */
export type MatrixScoreOrigin = MatrixScoreSource | 'legacy';

export interface MatrixPlacement {
  importance: number;
  urgency: number;
  quadrant: Quadrant;
  source: MatrixScoreOrigin;
  reason: string | null;
  confidence: number | null;
  /** True when the coordinates were converted from the old 1..5 integers. */
  legacy: boolean;
}

/** `>= 50` is high on either axis, mirroring the server's derivation. */
export function quadrantFromScores(importance: number, urgency: number): Quadrant {
  const important = importance >= MATRIX_HIGH_THRESHOLD;
  const urgent = urgency >= MATRIX_HIGH_THRESHOLD;
  if (important && urgent) return 'q1';
  if (important && !urgent) return 'q2';
  if (!important && urgent) return 'q3';
  return 'q4';
}

export const isValidMatrixScore = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= MATRIX_SCORE_MIN &&
  value <= MATRIX_SCORE_MAX;

/**
 * Coarse conversion of a legacy 1..5 integer onto the 0..100 axis.
 *
 * The thresholds are chosen so the old classification is preserved: 4 and 5
 * were "high" (old boundary 3.5) and land at >= 50 here, 1..3 stay below it.
 * These values are a display convenience, never a model judgement.
 */
export function legacyScoreToMatrixScore(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  switch (rounded) {
    case 1:
      return 10;
    case 2:
      return 30;
    case 3:
      return 45;
    case 4:
      return 70;
    case 5:
      return 90;
    default:
      return null;
  }
}

/**
 * Resolves a task's position on the 0..100 × 0..100 plane.
 *
 * Returns `null` when the task carries no usable score at all — those belong in
 * the separate "awaiting scoring" area rather than in the middle of the chart.
 */
export function resolveMatrixPlacement(task: MatrixTaskLike): MatrixPlacement | null {
  const importance = task.matrix_importance_score;
  const urgency = task.matrix_urgency_score;

  if (isValidMatrixScore(importance) && isValidMatrixScore(urgency)) {
    const source = task.matrix_score_source ?? 'unset';
    return {
      importance,
      urgency,
      quadrant: quadrantFromScores(importance, urgency),
      source,
      reason: task.matrix_score_reason ?? null,
      confidence: task.matrix_score_confidence ?? null,
      legacy: source === 'legacy',
    };
  }

  const legacyImportance =
    typeof task.importance === 'number' ? legacyScoreToMatrixScore(task.importance) : null;
  const legacyUrgency =
    typeof task.urgency === 'number' ? legacyScoreToMatrixScore(task.urgency) : null;

  if (legacyImportance == null || legacyUrgency == null) return null;

  return {
    importance: legacyImportance,
    urgency: legacyUrgency,
    quadrant: quadrantFromScores(legacyImportance, legacyUrgency),
    source: 'legacy',
    reason: task.matrix_score_reason ?? null,
    confidence: null,
    legacy: true,
  };
}

// ── stable short codes ──────────────────────────────────────────────────────

/** Unambiguous alphabet: no I/O/0/1, so a code can be read out loud. */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** FNV-1a — small, stable across runs, and good enough for a 4-char label. */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Derives a task's short code from its id alone.
 *
 * Deliberately independent of ordering and of the queue position: the same task
 * keeps the same code across filters, sorts, zooms and reloads.
 */
export function shortCodeFor(id: string, length = 4): string {
  let hash = hashId(id);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[hash % CODE_ALPHABET.length];
    hash = Math.floor(hash / CODE_ALPHABET.length) + 7;
  }
  return code;
}

/**
 * Short codes for a set of ids, with collisions resolved deterministically.
 *
 * Ids are processed in sorted order so the resolution never depends on the order
 * the caller happened to pass them in.
 */
export function assignShortCodes(ids: string[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();

  for (const id of [...new Set(ids)].sort()) {
    const base = shortCodeFor(id);
    let code = base;
    let suffix = 2;
    while (used.has(code)) {
      code = `${base.slice(0, 3)}${suffix}`;
      suffix += 1;
      if (suffix > 9) {
        // Exhausted the single-digit suffixes; fall back to a longer code.
        code = shortCodeFor(id, 6);
        if (used.has(code)) code = `${code}${used.size}`;
        break;
      }
    }
    used.add(code);
    assigned.set(id, code);
  }

  return assigned;
}

// ── clustering ──────────────────────────────────────────────────────────────

export interface MatrixPoint {
  id: string;
  code: string;
  importance: number;
  urgency: number;
  quadrant: Quadrant;
  /** Projected pixel position for the current zoom window. */
  px: number;
  py: number;
}

export interface MatrixCluster {
  /** Stable key: the smallest member id, so React keys survive a re-cluster. */
  key: string;
  quadrant: Quadrant;
  /** Every member, in sorted-id order. Never trimmed. */
  points: MatrixPoint[];
  /** Representative coordinates: the mean of the members' real scores. */
  importance: number;
  urgency: number;
  /** True when every member shares the exact same pair of scores. */
  identical: boolean;
}

const mean = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Groups points that render within `radiusPx` of each other.
 *
 * Two rules the view depends on:
 * - a cluster never spans two quadrants, so the per-quadrant counts below the
 *   chart always add up;
 * - no point is ever dropped, so a cluster of identical scores can still be
 *   expanded into a full task list on click.
 *
 * Deterministic: points are visited in (px, py, id) order and the real scores
 * are left untouched — zooming re-runs this with new pixel positions only.
 */
export function clusterMatrixPoints(points: MatrixPoint[], radiusPx: number): MatrixCluster[] {
  const ordered = [...points].sort(
    (a, b) => a.px - b.px || a.py - b.py || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken = new Set<string>();
  const clusters: MatrixCluster[] = [];
  const radius = Math.max(0, radiusPx);

  for (const seed of ordered) {
    if (taken.has(seed.id)) continue;
    taken.add(seed.id);
    const members = [seed];

    if (radius > 0) {
      for (const candidate of ordered) {
        if (taken.has(candidate.id)) continue;
        if (candidate.quadrant !== seed.quadrant) continue;
        const dx = candidate.px - seed.px;
        const dy = candidate.py - seed.py;
        if (Math.sqrt(dx * dx + dy * dy) <= radius) {
          taken.add(candidate.id);
          members.push(candidate);
        }
      }
    }

    const sorted = members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    clusters.push({
      key: sorted[0].id,
      quadrant: seed.quadrant,
      points: sorted,
      importance: mean(sorted.map((point) => point.importance)),
      urgency: mean(sorted.map((point) => point.urgency)),
      identical: sorted.every(
        (point) =>
          point.importance === sorted[0].importance && point.urgency === sorted[0].urgency,
      ),
    });
  }

  return clusters.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ── escaping ────────────────────────────────────────────────────────────────

/**
 * Escapes text for interpolation into an HTML string.
 *
 * The chart tooltip is rendered from an HTML string, so a task title the user
 * typed — which may legitimately contain `<` or quotes — has to go through here
 * before it is concatenated in.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── statistics ──────────────────────────────────────────────────────────────
export interface MatrixQuadrantStat {
  quadrant: Quadrant;
  count: number;
  /** Share of all scored tasks, 0..1. Zero when nothing is scored. */
  ratio: number;
}

export interface MatrixStats {
  /** Denominator: every filtered task that carries a usable pair of scores. */
  scored: number;
  unscored: number;
  byQuadrant: Record<Quadrant, MatrixQuadrantStat>;
}

const QUADRANT_KEYS: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];

/**
 * Counts and shares per quadrant.
 *
 * Computed from the filtered task list, never from the clusters: zooming must
 * not change the numbers shown underneath the chart.
 */
export function matrixStats(tasks: MatrixTaskLike[]): MatrixStats {
  const counts: Record<Quadrant, number> = { q1: 0, q2: 0, q3: 0, q4: 0 };
  let scored = 0;
  let unscored = 0;

  for (const task of tasks) {
    const placement = resolveMatrixPlacement(task);
    if (!placement) {
      unscored += 1;
      continue;
    }
    scored += 1;
    counts[placement.quadrant] += 1;
  }

  const byQuadrant = {} as Record<Quadrant, MatrixQuadrantStat>;
  for (const quadrant of QUADRANT_KEYS) {
    byQuadrant[quadrant] = {
      quadrant,
      count: counts[quadrant],
      ratio: scored === 0 ? 0 : counts[quadrant] / scored,
    };
  }

  return { scored, unscored, byQuadrant };
}

// ── quadrant review ────────────────────────────────────────────────────────

/**
 * A task whose quadrant was suggested but not yet confirmed by the person.
 *
 * Single source of truth for the "待确认" marker: the four-column summary rows,
 * the full card and the `/matrix` filter all read it from here.
 */
export const needsQuadrantReview = (
  task: Pick<MatrixSummaryTaskLike, 'quadrant' | 'quadrant_confirmed'>,
): boolean => !task.quadrant_confirmed && task.quadrant != null;

// ── four-column summary rows ───────────────────────────────────────────────

/**
 * What the compact summary row needs on top of the placement fields.
 *
 * `/matrix` deliberately renders these instead of a full `TaskCard` in each of
 * the four columns — the full card (with every action) opens in a dialog.
 */
export interface MatrixSummaryTaskLike extends MatrixTaskLike {
  title: string;
  status: TaskStatus;
  quadrant_confirmed?: boolean;
  is_demo?: boolean;
}

/**
 * One line of the four-column review table.
 *
 * Purely derived: no formatting, no translation, no HTML. The view maps
 * `status`/`quadrant` through the existing label tables and renders
 * `importance`/`urgency` with `formatMatrixScore`.
 */
export interface MatrixSummaryRow {
  id: string;
  /** Stable short code, identical to the one on the chart. */
  code: string;
  title: string;
  isDemo: boolean;
  status: TaskStatus;
  /** Null when the task carries no usable pair of scores. */
  importance: number | null;
  urgency: number | null;
  /** Placement quadrant, or null for an unscored task. */
  quadrant: Quadrant | null;
  /** Converted from the old 1..5 integers. */
  legacy: boolean;
  /** Awaiting the person's confirmation of a suggested quadrant. */
  needsReview: boolean;
}

/** Builds the summary row for one task. */
export function matrixSummaryRow(
  task: MatrixSummaryTaskLike,
  codes?: Map<string, string>,
): MatrixSummaryRow {
  const placement = resolveMatrixPlacement(task);
  return {
    id: task.id,
    code: codes?.get(task.id) ?? shortCodeFor(task.id),
    title: task.title,
    isDemo: task.is_demo === true,
    status: task.status,
    importance: placement ? placement.importance : null,
    urgency: placement ? placement.urgency : null,
    quadrant: placement ? placement.quadrant : null,
    legacy: placement ? placement.legacy : false,
    needsReview: needsQuadrantReview(task),
  };
}

/**
 * Groups the summary rows into the four columns.
 *
 * Scored tasks only — an unscored task has no quadrant and belongs in the
 * separate "待评分" area, exactly as in `matrixStats`. Each column keeps the
 * input order, so the four columns and the statistics always agree.
 */
export function matrixSummaryByQuadrant(
  tasks: MatrixSummaryTaskLike[],
  codes?: Map<string, string>,
): Record<Quadrant, MatrixSummaryRow[]> {
  const columns: Record<Quadrant, MatrixSummaryRow[]> = { q1: [], q2: [], q3: [], q4: [] };
  for (const task of tasks) {
    const row = matrixSummaryRow(task, codes);
    if (row.quadrant == null) continue;
    columns[row.quadrant].push(row);
  }
  return columns;
}
