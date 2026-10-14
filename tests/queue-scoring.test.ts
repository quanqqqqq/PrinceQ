/** Unit tests for the explainable queue scoring engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTasks, scoreTask, buildScoringContext } from '../server/domain/queue.ts';
import { emptyHabits, hoursFromNow, makeTask } from './helpers.ts';

const AT = new Date('2026-06-15T10:00:00.000Z');

const score = (task: Parameters<typeof scoreTask>[0], habits = emptyHabits()) =>
  scoreTask(task, buildScoringContext([task], habits, AT));

test('score breakdown exposes every weighted factor with a contribution and detail', () => {
  const breakdown = score(makeTask({ estimated_minutes: 30 }));

  assert.deepEqual(
    breakdown.factors.map((f) => f.key),
    ['deadline', 'manual_priority', 'dependency', 'effort', 'habit_alignment', 'context_switch'],
  );
  for (const factor of breakdown.factors) {
    assert.ok(factor.label.length > 0, `${factor.key} has a label`);
    assert.ok(factor.detail.length > 0, `${factor.key} explains itself`);
    assert.equal(typeof factor.contribution, 'number');
  }
  // Contributions must reconstruct the score exactly (no hidden terms).
  const sum = breakdown.factors.reduce((total, f) => total + f.contribution, 0);
  assert.ok(Math.abs(sum - breakdown.score) < 0.05, `${sum} ≈ ${breakdown.score}`);
});

test('deadline pressure increases monotonically as the due date approaches', () => {
  const at = (hours: number | null) =>
    score(makeTask({ deadline: hours === null ? null : hoursFromNow(hours, AT) })).factors.find(
      (f) => f.key === 'deadline',
    )!.value;

  const overdue = at(-5);
  const today = at(6);
  const threeDays = at(60);
  const thisWeek = at(120);
  const thisMonth = at(600);
  const farOut = at(2000);

  assert.ok(overdue > today, 'overdue beats due-today');
  assert.ok(today > threeDays);
  assert.ok(threeDays > thisWeek);
  assert.ok(thisWeek > thisMonth);
  assert.ok(thisMonth > farOut);
  assert.equal(at(null), 0.35, 'no deadline is neutral');
});

test('unmet dependencies penalise the score and are flagged in the notes', () => {
  const ready = score(makeTask({ depends_on: ['a'], dependency_ready: true }));
  const blocked = score(makeTask({ depends_on: ['a'], dependency_ready: false }));

  assert.ok(blocked.score < ready.score, 'unready task scores lower');
  assert.ok(
    blocked.notes.some((n) => /dependency is unfinished/i.test(n)),
    'explains why it is not startable',
  );
});

test('a task that unblocks others scores above an otherwise identical leaf task', () => {
  const leaf = score(makeTask({ estimated_minutes: 60 }));
  const unblocker = score(makeTask({ estimated_minutes: 60, blocks: ['x', 'y'] }));

  assert.ok(unblocker.score > leaf.score);
  const factor = unblocker.factors.find((f) => f.key === 'dependency')!;
  assert.match(factor.detail, /unblocks 2 other task/);
});

test('effort factor favours finishable work over multi-hour tasks', () => {
  const quick = score(makeTask({ estimated_minutes: 10 }));
  const long = score(makeTask({ estimated_minutes: 300 }));
  const unestimated = score(makeTask({ estimated_minutes: null }));

  assert.ok(quick.score > long.score, 'quick win outranks a 5-hour task');
  const unestimatedValue = unestimated.factors.find((f) => f.key === 'effort')!.value;
  assert.equal(unestimatedValue, 0.4, 'missing estimate takes an uncertainty discount');
});

test('manual priority shifts the score in the expected direction', () => {
  const low = score(makeTask({ manual_priority: -2 }));
  const neutral = score(makeTask({ manual_priority: 0 }));
  const high = score(makeTask({ manual_priority: 2 }));

  assert.ok(low.score < neutral.score);
  assert.ok(neutral.score < high.score);
});

test('manual override is applied verbatim after weighting and recorded in notes', () => {
  const base = score(makeTask());
  const boosted = score(makeTask({ manual_override: 25 }));

  assert.ok(Math.abs(boosted.score - (base.score + 25)) < 0.01, 'override adds exactly 25');
  assert.ok(boosted.notes.some((n) => /Manual override of \+25/.test(n)));
});

test('habit weights change the ranking without changing the factor set', () => {
  const urgent = makeTask({ title: 'urgent', deadline: hoursFromNow(2, AT), estimated_minutes: 240 });
  const quick = makeTask({ title: 'quick', deadline: null, estimated_minutes: 10 });

  const deadlineDriven = rankTasks(
    [urgent, quick],
    emptyHabits({ weights: { ...emptyHabits().weights, deadline: 2, effort: 0 } }),
    AT,
  );
  assert.equal(deadlineDriven[0].task.title, 'urgent');

  const effortDriven = rankTasks(
    [urgent, quick],
    emptyHabits({ weights: { ...emptyHabits().weights, deadline: 0, effort: 2 } }),
    AT,
  );
  assert.equal(effortDriven[0].task.title, 'quick', 'zeroing the deadline weight flips the order');
});

test('preferred task types and peak hours lift habit alignment', () => {
  const task = makeTask({ task_type: 'deep_work', cognitive_load: 'high' });
  const peakHour = AT.getHours();

  const neutral = score(task, emptyHabits());
  const aligned = score(
    task,
    emptyHabits({ preferredTaskTypes: ['deep_work'], peakHours: [peakHour] }),
  );

  assert.ok(aligned.score > neutral.score);
  const detail = aligned.factors.find((f) => f.key === 'habit_alignment')!.detail;
  assert.match(detail, /preferred task type/);
  assert.match(detail, /peak hour/);
});

test('hard constraints surface in the notes of every scored task', () => {
  const breakdown = score(
    makeTask(),
    emptyHabits({
      constraints: [
        { id: 'c1', statement: 'No work after 20:00', kind: 'forbidden_window', enabled: true, value: '20:00-07:00' },
      ],
    }),
  );
  assert.ok(breakdown.notes.some((n) => /No work after 20:00/.test(n)));
});

test('context continuity favours in-progress work and the same goal', () => {
  const active = makeTask({ status: 'in_progress', goal_id: 'g1', task_type: 'deep_work' });
  const sameGoal = makeTask({ goal_id: 'g1', task_type: 'deep_work' });
  const unrelated = makeTask({ goal_id: 'g2', task_type: 'admin' });

  const ctx = buildScoringContext([active, sameGoal, unrelated], emptyHabits(), AT);
  const continuity = (t: typeof active) =>
    scoreTask(t, ctx).factors.find((f) => f.key === 'context_switch')!.value;

  assert.ok(continuity(active) > continuity(sameGoal));
  assert.ok(continuity(sameGoal) > continuity(unrelated));
});

test('ranking only includes active statuses and numbers positions from 1', () => {
  const tasks = [
    makeTask({ title: 'inbox', status: 'inbox' }),
    makeTask({ title: 'claimed', status: 'claimed' }),
    makeTask({ title: 'in_progress', status: 'in_progress' }),
    makeTask({ title: 'blocked', status: 'blocked' }),
    makeTask({ title: 'completed', status: 'completed' }),
    makeTask({ title: 'archived', status: 'archived' }),
  ];

  const ranked = rankTasks(tasks, emptyHabits(), AT);

  assert.equal(ranked.length, 4, 'completed and archived are excluded');
  assert.deepEqual(
    ranked.map((r) => r.position),
    [1, 2, 3, 4],
  );
  assert.ok(!ranked.some((r) => ['completed', 'archived'].includes(r.task.title)));
});

test('ranking is ordered by descending score and is stable across repeated runs', () => {
  const tasks = [
    makeTask({ title: 'a', deadline: hoursFromNow(1, AT) }),
    makeTask({ title: 'b', deadline: hoursFromNow(100, AT) }),
    makeTask({ title: 'c', manual_priority: 2 }),
    makeTask({ title: 'd', estimated_minutes: 5 }),
  ];

  const first = rankTasks(tasks, emptyHabits(), AT);
  const second = rankTasks(tasks, emptyHabits(), AT);

  assert.deepEqual(
    first.map((r) => r.task.title),
    second.map((r) => r.task.title),
    'ranking is deterministic',
  );
  for (let i = 1; i < first.length; i += 1) {
    assert.ok(
      first[i - 1].breakdown.score >= first[i].breakdown.score,
      'scores descend monotonically',
    );
  }
});

test('ties break on deadline before creation order', () => {
  const soon = makeTask({ title: 'soon', deadline: hoursFromNow(10, AT), created_at: '2026-02-01T00:00:00.000Z' });
  const later = makeTask({ title: 'later', deadline: hoursFromNow(11, AT), created_at: '2026-01-01T00:00:00.000Z' });

  const ranked = rankTasks([later, soon], emptyHabits(), AT);
  assert.equal(ranked[0].task.title, 'soon', 'earlier deadline wins a score tie');
});

test('quadrant does not influence the queue score', () => {
  const base = { estimated_minutes: 60, deadline: hoursFromNow(48, AT) };
  const q1 = score(makeTask({ ...base, quadrant: 'q1', importance: 5, urgency: 5 }));
  const q4 = score(makeTask({ ...base, quadrant: 'q4', importance: 1, urgency: 1 }));

  assert.equal(q1.score, q4.score, 'the matrix is a separate lens from the queue');
});

test('an unconfirmed quadrant is noted but not scored', () => {
  const breakdown = score(makeTask({ quadrant: 'q1', quadrant_confirmed: false }));
  assert.ok(
    breakdown.notes.some((n) => /unconfirmed agent suggestion/.test(n)),
    'the UI can explain the pending confirmation',
  );
});
