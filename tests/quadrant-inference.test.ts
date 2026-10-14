/** Unit tests for deterministic Eisenhower quadrant inference. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferQuadrant, quadrantFor, QUADRANT_LABELS } from '../server/domain/quadrant.ts';
import { setClock } from '../server/lib/ids.ts';
import { hoursFromNow } from './helpers.ts';

const AT = new Date('2026-06-15T10:00:00.000Z');

test.before(() => setClock(() => AT));
test.after(() => setClock(null));

test('quadrantFor maps the importance/urgency plane onto the four quadrants', () => {
  assert.equal(quadrantFor(5, 5), 'q1', 'important + urgent');
  assert.equal(quadrantFor(5, 1), 'q2', 'important, not urgent');
  assert.equal(quadrantFor(1, 5), 'q3', 'urgent, not important');
  assert.equal(quadrantFor(1, 1), 'q4', 'neither');
  // The 3.5 boundary is inclusive on the "high" side.
  assert.equal(quadrantFor(3.5, 3.5), 'q1');
  assert.equal(quadrantFor(3.49, 3.49), 'q4');
});

test('an incident with an imminent deadline infers q1 with high confidence', () => {
  const result = inferQuadrant({
    title: 'Fix the production outage affecting customer invoices',
    deadline: hoursFromNow(3, AT),
    cognitive_load: 'high',
    task_type: 'deep_work',
  });

  assert.equal(result.quadrant, 'q1');
  assert.ok(result.confidence >= 0.7, `confidence ${result.confidence} is high`);
  assert.ok(result.signals.some((s) => /incident language/.test(s)));
  assert.ok(result.signals.some((s) => /due within 24h/.test(s)));
});

test('strategic work with a distant deadline infers q2', () => {
  const result = inferQuadrant({
    title: 'Draft the architecture roadmap for next year',
    deadline: hoursFromNow(24 * 60, AT),
    estimated_minutes: 180,
    cognitive_load: 'high',
    task_type: 'deep_work',
  });

  assert.equal(result.quadrant, 'q2');
  assert.match(result.reason, /Important, not urgent/);
});

test('an urgent but low-stakes interruption infers q3', () => {
  const result = inferQuadrant({
    title: 'Reply to the newsletter sponsorship ping today',
    deadline: hoursFromNow(5, AT),
    estimated_minutes: 10,
    cognitive_load: 'low',
    task_type: 'communication',
  });

  assert.equal(result.quadrant, 'q3');
  assert.match(QUADRANT_LABELS[result.quadrant], /batch or delegate/);
});

test('an explicitly deferred low-value chore infers q4', () => {
  const result = inferQuadrant({
    title: 'Someday tidy up my browser bookmarks, optional',
    estimated_minutes: 15,
    cognitive_load: 'low',
    task_type: 'admin',
  });

  assert.equal(result.quadrant, 'q4');
});

test('importance and urgency are always returned on the 1..5 scale', () => {
  const extreme = inferQuadrant({
    title: 'URGENT production outage incident, security and compliance, customer revenue, asap today',
    deadline: hoursFromNow(-10, AT),
    cognitive_load: 'high',
    goal_title: 'Critical goal',
  });
  const minimal = inferQuadrant({
    title: 'someday maybe optional nice to have newsletter browse',
    task_type: 'admin',
    cognitive_load: 'low',
  });

  for (const result of [extreme, minimal]) {
    assert.ok(result.importance >= 1 && result.importance <= 5, `importance ${result.importance}`);
    assert.ok(result.urgency >= 1 && result.urgency <= 5, `urgency ${result.urgency}`);
    assert.ok(Number.isInteger(result.importance));
    assert.ok(Number.isInteger(result.urgency));
  }
  assert.equal(extreme.importance, 5);
  assert.equal(extreme.urgency, 5);
  assert.equal(minimal.importance, 1);
});

test('confidence stays inside the documented 0.2..0.95 band', () => {
  const inputs = [
    { title: 'Thing' },
    { title: 'Urgent incident outage asap today customer revenue', deadline: hoursFromNow(-1, AT) },
    { title: 'someday maybe', task_type: 'admin' as const },
    { title: 'Learn about databases', task_type: 'learning' as const, goal_title: 'Growth' },
  ];

  for (const input of inputs) {
    const { confidence } = inferQuadrant(input);
    assert.ok(confidence >= 0.2 && confidence <= 0.95, `confidence ${confidence} in band`);
  }
});

test('a signal-free title yields low confidence and says so', () => {
  const result = inferQuadrant({ title: 'Thing' });

  assert.ok(result.confidence <= 0.6, `confidence ${result.confidence} is low`);
  assert.ok(result.signals.some((s) => /no strong signals/.test(s)));
});

test('the reason always states the quadrant, derived scores and pending confirmation', () => {
  const result = inferQuadrant({ title: 'Ship the customer launch by tomorrow' });

  assert.match(result.reason, /importance/i);
  assert.match(result.reason, /urgency/i);
  assert.match(result.reason, /Confidence \d+%/);
  assert.match(result.reason, /awaiting your confirmation/i);
});

test('deadline proximity alone moves a task between quadrants', () => {
  const base = { title: 'Prepare the quarterly report', task_type: 'deep_work' as const };

  const soon = inferQuadrant({ ...base, deadline: hoursFromNow(6, AT) });
  const distant = inferQuadrant({ ...base, deadline: hoursFromNow(24 * 45, AT) });

  assert.ok(soon.urgency > distant.urgency, 'nearer deadline is more urgent');
  assert.equal(distant.quadrant, 'q2');
});

test('linking a goal raises importance', () => {
  const alone = inferQuadrant({ title: 'Write the migration script' });
  const linked = inferQuadrant({ title: 'Write the migration script', goal_title: 'Billing rewrite' });

  assert.ok(linked.importance >= alone.importance);
  assert.ok(linked.signals.some((s) => /linked to goal/.test(s)));
});

test('task type bias separates communication from learning', () => {
  const comms = inferQuadrant({ title: 'Sync with the team', task_type: 'communication' });
  const learning = inferQuadrant({ title: 'Sync with the team', task_type: 'learning' });

  assert.ok(comms.urgency > learning.urgency, 'communication skews urgent');
  assert.ok(learning.importance > comms.importance, 'learning skews important');
});

test('inference is deterministic for identical input', () => {
  const input = {
    title: 'Fix the urgent billing defect for a customer',
    deadline: hoursFromNow(20, AT),
    estimated_minutes: 60,
    cognitive_load: 'high' as const,
    task_type: 'deep_work' as const,
  };

  const a = inferQuadrant(input);
  const b = inferQuadrant(input);

  assert.deepEqual(a, b, 'no randomness or model call involved');
});
