/**
 * Unit tests for the pure matrix-view helpers: placement/boundaries, stable
 * short codes, screen-distance clustering and the per-quadrant statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignShortCodes,
  clusterMatrixPoints,
  escapeHtml,
  isValidMatrixScore,
  legacyScoreToMatrixScore,
  matrixStats,
  quadrantFromScores,
  resolveMatrixPlacement,
  shortCodeFor,
  type MatrixPoint,
  type MatrixTaskLike,
} from '../shared/matrix-view.ts';

/** A scored task, with only the fields the helpers read. */
const scored = (
  id: string,
  importance: number | null,
  urgency: number | null,
  extra: Partial<MatrixTaskLike> = {},
): MatrixTaskLike => ({
  id,
  matrix_importance_score: importance,
  matrix_urgency_score: urgency,
  matrix_score_source: 'agent',
  ...extra,
});

const point = (id: string, px: number, py: number, extra: Partial<MatrixPoint> = {}): MatrixPoint => ({
  id,
  code: shortCodeFor(id),
  importance: 60,
  urgency: 60,
  quadrant: 'q1',
  px,
  py,
  ...extra,
});

// ── boundaries ──────────────────────────────────────────────────────────────

test('quadrantFromScores treats 50 as high on both axes', () => {
  assert.equal(quadrantFromScores(100, 100), 'q1');
  assert.equal(quadrantFromScores(50, 50), 'q1', '50 is inclusive on the high side');
  assert.equal(quadrantFromScores(100, 0), 'q2');
  assert.equal(quadrantFromScores(0, 100), 'q3');
  assert.equal(quadrantFromScores(0, 0), 'q4');
  assert.equal(quadrantFromScores(49.9, 49.9), 'q4', 'just below the midline is low');
  assert.equal(quadrantFromScores(50, 49.9), 'q2');
  assert.equal(quadrantFromScores(49.9, 50), 'q3');
});

test('isValidMatrixScore accepts 0..100 including decimals and rejects the rest', () => {
  assert.equal(isValidMatrixScore(0), true);
  assert.equal(isValidMatrixScore(100), true);
  assert.equal(isValidMatrixScore(72.5), true);
  assert.equal(isValidMatrixScore(-0.1), false);
  assert.equal(isValidMatrixScore(100.1), false);
  assert.equal(isValidMatrixScore(Number.NaN), false);
  assert.equal(isValidMatrixScore(null), false);
  assert.equal(isValidMatrixScore('80'), false);
});

test('resolveMatrixPlacement keeps the exact scores and derives the quadrant', () => {
  const placement = resolveMatrixPlacement(
    scored('t1', 72.5, 31.2, { matrix_score_reason: '客户影响大但无截止压力', matrix_score_confidence: 0.8 }),
  );
  assert.ok(placement);
  assert.equal(placement.importance, 72.5, 'the original value is never rounded or jittered');
  assert.equal(placement.urgency, 31.2);
  assert.equal(placement.quadrant, 'q2');
  assert.equal(placement.source, 'agent');
  assert.equal(placement.legacy, false);
  assert.equal(placement.confidence, 0.8);
  assert.equal(placement.reason, '客户影响大但无截止压力');
});

test('resolveMatrixPlacement returns null when a score is missing or out of range', () => {
  assert.equal(resolveMatrixPlacement({ id: 'a' }), null, 'no scores at all');
  assert.equal(resolveMatrixPlacement(scored('b', 80, null)), null, 'only one axis');
  assert.equal(
    resolveMatrixPlacement({ id: 'c', matrix_importance_score: 120, matrix_urgency_score: 50 }),
    null,
    'out of range is not silently clamped',
  );
  assert.equal(
    resolveMatrixPlacement({ id: 'd', matrix_importance_score: -5, matrix_urgency_score: 50 }),
    null,
  );
});

test('legacy 1..5 integers fall back to a coarse mapping that preserves the old class', () => {
  // The old boundary was 3.5, so 4 and 5 must stay high and 1..3 stay low.
  assert.equal(legacyScoreToMatrixScore(1), 10);
  assert.equal(legacyScoreToMatrixScore(3), 45);
  assert.ok(legacyScoreToMatrixScore(4)! >= 50);
  assert.ok(legacyScoreToMatrixScore(5)! >= 50);
  assert.equal(legacyScoreToMatrixScore(0), null);
  assert.equal(legacyScoreToMatrixScore(6), null);

  const placement = resolveMatrixPlacement({ id: 'old', importance: 5, urgency: 2 });
  assert.ok(placement);
  assert.equal(placement.quadrant, 'q2', 'important, not urgent — same as before');
  assert.equal(placement.source, 'legacy');
  assert.equal(placement.legacy, true, 'flagged so the UI can say it awaits a real re-score');
  assert.equal(placement.confidence, null, 'a conversion carries no confidence');
});

test('new scores win over the legacy integers', () => {
  const placement = resolveMatrixPlacement(
    scored('mixed', 20, 20, { importance: 5, urgency: 5 }),
  );
  assert.ok(placement);
  assert.equal(placement.quadrant, 'q4');
  assert.equal(placement.legacy, false);
});

// ── short codes ─────────────────────────────────────────────────────────────

test('short codes are derived from the id, not from any ordering', () => {
  const ids = ['task-a', 'task-b', 'task-c'];
  const forward = assignShortCodes(ids);
  const reversed = assignShortCodes([...ids].reverse());
  for (const id of ids) {
    assert.equal(forward.get(id), reversed.get(id), `${id} keeps its code`);
  }
  // Adding a task must not renumber the others (unlike a queue position).
  const grown = assignShortCodes([...ids, 'task-d']);
  for (const id of ids) {
    assert.equal(grown.get(id), forward.get(id));
  }
});

test('short codes are unique, readable and of a fixed width', () => {
  const ids = Array.from({ length: 500 }, (_, index) => `task-${index}`);
  const codes = assignShortCodes(ids);
  assert.equal(codes.size, ids.length);
  assert.equal(new Set(codes.values()).size, ids.length, 'no duplicate codes');
  for (const code of codes.values()) {
    assert.match(code, /^[2-9A-HJ-NP-Z]{3}[2-9A-HJ-NP-Z]$|^[2-9A-HJ-NP-Z]{3}[2-9]$/);
    assert.equal(code.length, 4);
  }
});

test('shortCodeFor is stable across calls', () => {
  assert.equal(shortCodeFor('abc'), shortCodeFor('abc'));
  assert.notEqual(shortCodeFor('abc'), shortCodeFor('abd'));
});

// ── clustering ──────────────────────────────────────────────────────────────

test('nearby points merge, distant points do not, and nothing is dropped', () => {
  const points = [
    point('a', 100, 100),
    point('b', 104, 103),
    point('c', 400, 100),
  ];
  const clusters = clusterMatrixPoints(points, 10);
  assert.equal(clusters.length, 2);
  const ids = clusters.flatMap((cluster) => cluster.points.map((p) => p.id)).sort();
  assert.deepEqual(ids, ['a', 'b', 'c'], 'every task id survives clustering');
  const merged = clusters.find((cluster) => cluster.points.length === 2);
  assert.ok(merged);
  assert.deepEqual(merged.points.map((p) => p.id), ['a', 'b']);
});

test('clusters never span two quadrants even when the points overlap on screen', () => {
  const clusters = clusterMatrixPoints(
    [
      point('q1-task', 200, 200, { quadrant: 'q1', importance: 50, urgency: 50 }),
      point('q4-task', 201, 201, { quadrant: 'q4', importance: 49.9, urgency: 49.9 }),
    ],
    20,
  );
  assert.equal(clusters.length, 2, 'the midline is a hard boundary');
  for (const cluster of clusters) {
    assert.equal(cluster.points.length, 1);
  }
});

test('zooming in splits a cluster because the pixel distance grows', () => {
  const near = [point('a', 100, 100), point('b', 110, 100)];
  const far = [point('a', 100, 100), point('b', 300, 100)];
  assert.equal(clusterMatrixPoints(near, 20).length, 1, 'zoomed out: one cluster');
  assert.equal(clusterMatrixPoints(far, 20).length, 2, 'zoomed in: two clusters');
});

test('identical scores stay in one cluster at any zoom and are flagged as identical', () => {
  const same = [
    point('a', 100, 100, { importance: 80, urgency: 80 }),
    point('b', 100, 100, { importance: 80, urgency: 80 }),
    point('c', 100, 100, { importance: 80, urgency: 80 }),
  ];
  for (const radius of [0, 1, 40]) {
    const clusters = clusterMatrixPoints(same, radius);
    const total = clusters.reduce((sum, cluster) => sum + cluster.points.length, 0);
    assert.equal(total, 3, 'all three remain selectable');
    if (radius > 0) {
      assert.equal(clusters.length, 1, 'they cannot be pulled apart by zooming');
      assert.equal(clusters[0].identical, true);
      assert.equal(clusters[0].importance, 80, 'the real coordinates are unchanged');
      assert.equal(clusters[0].urgency, 80);
    }
  }
});

test('a zero radius disables clustering', () => {
  const clusters = clusterMatrixPoints([point('a', 10, 10), point('b', 10, 10)], 0);
  assert.equal(clusters.length, 2);
});

test('clustering is deterministic regardless of input order', () => {
  const points = [point('a', 100, 100), point('b', 104, 103), point('c', 400, 100)];
  const forward = clusterMatrixPoints(points, 10);
  const reversed = clusterMatrixPoints([...points].reverse(), 10);
  assert.deepEqual(
    forward.map((cluster) => [cluster.key, cluster.points.map((p) => p.id)]),
    reversed.map((cluster) => [cluster.key, cluster.points.map((p) => p.id)]),
  );
});

test('clustering an empty set yields no clusters', () => {
  assert.deepEqual(clusterMatrixPoints([], 20), []);
});

// ── statistics ──────────────────────────────────────────────────────────────

test('escapeHtml neutralises a task title containing markup', () => {
  const title = '<img src=x onerror="alert(1)"> & \'done\'';
  const escaped = escapeHtml(title);
  assert.equal(
    escaped,
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;done&#39;',
  );
  assert.ok(!escaped.includes('<'), 'no raw tag can reach the tooltip HTML');
  assert.ok(!escaped.includes('"'), 'no raw quote can break out of an attribute');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml('普通标题'), '普通标题', 'ordinary text passes through unchanged');
});

test('quadrant counts and shares use the scored tasks as the denominator', () => {
  const stats = matrixStats([
    scored('a', 90, 90), // q1
    scored('b', 90, 10), // q2
    scored('c', 10, 90), // q3
    scored('d', 10, 10), // q4
    scored('e', 90, 90), // q1
    { id: 'f' }, // unscored
  ]);

  assert.equal(stats.scored, 5);
  assert.equal(stats.unscored, 1, 'unscored tasks are counted separately, not at the centre');
  assert.equal(stats.byQuadrant.q1.count, 2);
  assert.equal(stats.byQuadrant.q1.ratio, 2 / 5);
  assert.equal(stats.byQuadrant.q4.count, 1);

  const total = (['q1', 'q2', 'q3', 'q4'] as const).reduce(
    (sum, quadrant) => sum + stats.byQuadrant[quadrant].count,
    0,
  );
  assert.equal(total, stats.scored, 'the four columns account for every scored task');
});

test('matrixStats is safe on an empty list', () => {
  const stats = matrixStats([]);
  assert.equal(stats.scored, 0);
  assert.equal(stats.unscored, 0);
  assert.equal(stats.byQuadrant.q2.ratio, 0, 'no division by zero');
});

test('the chart and the four columns agree on the per-quadrant counts', () => {
  const tasks = [
    scored('a', 100, 100),
    scored('b', 50, 50),
    scored('c', 50, 49.9),
    scored('d', 0, 0),
    { id: 'e', importance: 4, urgency: 4 },
  ];
  const stats = matrixStats(tasks);

  const points: MatrixPoint[] = tasks.flatMap((task) => {
    const placement = resolveMatrixPlacement(task);
    if (!placement) return [];
    return [
      point(task.id, placement.urgency * 4, placement.importance * 4, {
        importance: placement.importance,
        urgency: placement.urgency,
        quadrant: placement.quadrant,
      }),
    ];
  });

  for (const radius of [0, 25, 200]) {
    const clusters = clusterMatrixPoints(points, radius);
    for (const quadrant of ['q1', 'q2', 'q3', 'q4'] as const) {
      const inChart = clusters
        .filter((cluster) => cluster.quadrant === quadrant)
        .reduce((sum, cluster) => sum + cluster.points.length, 0);
      assert.equal(
        inChart,
        stats.byQuadrant[quadrant].count,
        `${quadrant} matches at radius ${radius} — zooming never changes the statistics`,
      );
    }
  }
});
