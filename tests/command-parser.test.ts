/**
 * Unit tests for the deterministic command parser.
 *
 * The parser is the only thing standing between a line of natural-ish language
 * and a write, so the cases that must never regress are: trailing date/estimate
 * phrases leaking into titles, and destructive or ambiguous input being matched
 * as an actionable command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, SUPPORTED_COMMANDS } from '../server/agent/commands.ts';

/** Narrows the intent union so each test can assert on its own fields. */
function expectKind<K extends ReturnType<typeof parseCommand>['kind']>(
  input: string,
  kind: K,
): Extract<ReturnType<typeof parseCommand>, { kind: K }> {
  const intent = parseCommand(input);
  assert.equal(intent.kind, kind, `expected "${input}" to parse as ${kind}, got ${intent.kind}`);
  return intent as Extract<ReturnType<typeof parseCommand>, { kind: K }>;
}

test('a trailing estimate phrase does not leak into the task title', () => {
  const intent = expectKind('create task Polish the onboarding copy tomorrow, takes 45m', 'create_task');
  // Regression: the comma left behind by the estimate strip used to survive.
  assert.equal(intent.title, 'Polish the onboarding copy');
  assert.equal(intent.minutes, 45);
  assert.ok(intent.deadline, 'tomorrow should still resolve to a deadline');
});

test('a bare trailing date is stripped from the title without a preposition', () => {
  assert.equal(
    expectKind('create task Review the billing migration tomorrow', 'create_task').title,
    'Review the billing migration',
  );
  assert.equal(
    expectKind('create task Review the billing migration by tomorrow', 'create_task').title,
    'Review the billing migration',
  );
  assert.equal(
    expectKind('create task Call the vendor at 2026-03-04', 'create_task').title,
    'Call the vendor',
  );
});

test('titles keep their own punctuation and colons', () => {
  assert.equal(
    expectKind('claim Demo: Design the new invoice schema', 'task_action').title,
    'Demo: Design the new invoice schema',
  );
  // A quoted title is taken verbatim, noise phrases and all.
  assert.equal(
    expectKind('start "Draft Q3 review notes, final pass"', 'task_action').title,
    'Draft Q3 review notes, final pass',
  );
});

test('habit commands match singular and plural wording', () => {
  // Regression: `/\bhabit\b/` missed "list habits", the brief's own phrasing.
  expectKind('list habits', 'list_habits');
  expectKind('show habits', 'list_habits');
  expectKind('list habit', 'list_habits');
  assert.equal(
    expectKind('add habit I focus best before noon', 'add_habit').statement,
    'I focus best before noon',
  );
  assert.equal(
    expectKind('disable habit deep work before noon', 'disable_habit').statement,
    'deep work before noon',
  );
});

test('an explain request resolves the subject, not the ranking words', () => {
  assert.equal(
    expectKind('why is "Fix the production incident" ranked first', 'explain').title,
    'Fix the production incident',
  );
  assert.equal(expectKind('why is the incident ranked first', 'explain').title, 'the incident');
});

test('quadrant moves capture both the subject and the target quadrant', () => {
  const intent = expectKind('move the vendor renewal email to q1', 'change_quadrant');
  assert.equal(intent.title, 'the vendor renewal email');
  assert.equal(intent.quadrant, 'q1');
  assert.equal(parseCommand('set "Read the WAL doc" to quadrant 2').kind, 'change_quadrant');
  // A quadrant move with no destination must not be guessed at.
  expectKind('move the vendor renewal email to somewhere', 'unknown');
});

test('destructive and batch-like phrasing is held back rather than executed', () => {
  for (const input of [
    'delete all tasks',
    'archive everything',
    'complete all tasks',
    'wipe the database',
    'reset every goal',
  ]) {
    const intent = parseCommand(input);
    assert.equal(intent.kind, 'batch_warning', `"${input}" must not be executed directly`);
  }
});

test('"create a task to start X" is a create, not a start', () => {
  const intent = expectKind('create a task to start the migration', 'create_task');
  assert.match(intent.title, /migration/);
});

test('unmatched input becomes unknown instead of a wrong write', () => {
  expectKind('frobnicate the widget', 'unknown');
  expectKind('', 'unknown');
  expectKind('   ', 'unknown');
});

test('a task can be attached to a goal by name', () => {
  const intent = expectKind(
    'create task Write the migration script for goal Ship the billing rewrite',
    'create_task',
  );
  assert.equal(intent.goalTitle, 'Ship the billing rewrite');
  assert.equal(intent.title, 'Write the migration script');
});

test('show queue honours an explicit top-N and clamps it', () => {
  assert.equal(expectKind('show queue top 5', 'show_queue').limit, 5);
  assert.equal(expectKind('show me the queue', 'show_queue').limit, 10);
  assert.equal(expectKind('show queue top 999', 'show_queue').limit, 50);
});

test('every advertised command example parses to an actionable intent', () => {
  for (const { command, example } of SUPPORTED_COMMANDS) {
    const intent = parseCommand(example);
    assert.ok(
      intent.kind !== 'unknown' && intent.kind !== 'batch_warning',
      `advertised example for "${command}" (${example}) parsed as ${intent.kind}`,
    );
  }
});
