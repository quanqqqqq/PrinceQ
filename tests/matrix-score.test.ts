/**
 * Matrix-score domain and persistence tests.
 *
 * Everything runs against an in-memory database and a temporary habits
 * directory, so the user's real `data/work-queue.db` and `habits/` are never
 * touched.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { MATRIX_HIGH_THRESHOLD } from '../shared/types.ts';
import { get, type Db, type Row } from '../server/db/connection.ts';
import { legacyScoreFor, migrateTasksMatrixScores } from '../server/db/migrations.ts';
import {
  legacyAxisValue,
  quadrantFromScores,
  validateMatrixScore,
  validateScore,
} from '../server/domain/matrix-score.ts';
import { inferQuadrant } from '../server/domain/quadrant.ts';
import {
  changeQuadrant,
  createTask,
  resuggestQuadrant,
  scoreTaskMatrix,
  updateTask,
} from '../server/repo/task-service.ts';
import { findTask } from '../server/repo/tasks.ts';
import { freshDb, withTempHabits } from './helpers.ts';

const AGENT_SCORE = {
  importance_score: 82,
  urgency_score: 71.5,
  reason: '影响季度目标交付，且本周五前必须完成，否则阻塞下游。',
  source: 'agent' as const,
  confidence: 0.8,
};

describe('matrix score — the 0..100 scale', () => {
  it('derives each quadrant from the 50 boundary', () => {
    assert.equal(quadrantFromScores(100, 100), 'q1');
    assert.equal(quadrantFromScores(80, 60), 'q1');
    assert.equal(quadrantFromScores(80, 20), 'q2');
    assert.equal(quadrantFromScores(20, 80), 'q3');
    assert.equal(quadrantFromScores(0, 0), 'q4');
  });

  it('treats exactly 50 as high on both axes', () => {
    assert.equal(MATRIX_HIGH_THRESHOLD, 50);
    assert.equal(quadrantFromScores(50, 50), 'q1');
    assert.equal(quadrantFromScores(50, 49.9), 'q2');
    assert.equal(quadrantFromScores(49.9, 50), 'q3');
    assert.equal(quadrantFromScores(49.9, 49.9), 'q4');
  });

  it('accepts the 0 and 100 endpoints and one decimal place', () => {
    assert.equal(validateScore('importance', 0), 0);
    assert.equal(validateScore('urgency', 100), 100);
    assert.equal(validateScore('importance', 72.5), 72.5);
  });

  it('rejects out-of-range, non-numeric and over-precise values', () => {
    assert.throws(() => validateScore('importance', -0.1), /超出范围/);
    assert.throws(() => validateScore('urgency', 100.1), /超出范围/);
    assert.throws(() => validateScore('importance', Number.NaN), /必须是/);
    assert.throws(() => validateScore('urgency', '70' as unknown), /必须是/);
    assert.throws(() => validateScore('importance', 72.55), /1 位小数/);
  });

  it('requires a rationale and rejects a bogus source or confidence', () => {
    assert.throws(() => validateMatrixScore({ ...AGENT_SCORE, reason: '急' }), /评分理由/);
    assert.throws(
      () => validateMatrixScore({ ...AGENT_SCORE, source: 'rule' as unknown }),
      /评分来源/,
    );
    assert.throws(() => validateMatrixScore({ ...AGENT_SCORE, confidence: 1.4 }), /置信度/);
  });

  it('leaves an agent judgement unconfirmed and a user judgement confirmed', () => {
    assert.equal(validateMatrixScore(AGENT_SCORE).quadrant_confirmed, false);
    assert.equal(
      validateMatrixScore({ ...AGENT_SCORE, source: 'user' }).quadrant_confirmed,
      true,
    );
  });

  it('projects onto the legacy 1..5 column without crossing the boundary', () => {
    // High scores must land above the old 3.5 line, low scores below it.
    for (const score of [50, 65, 90, 100]) assert.ok(legacyAxisValue(score) >= 4);
    for (const score of [0, 20, 35, 49.9]) assert.ok(legacyAxisValue(score) <= 3);
  });
});

describe('matrix score — rule output is never labelled agent', () => {
  before(() => withTempHabits());

  it('the keyword rules report themselves as a rule, with matching scores', () => {
    const suggestion = inferQuadrant({ title: 'Production incident: checkout is down' });
    assert.equal(
      quadrantFromScores(suggestion.importance_score, suggestion.urgency_score),
      suggestion.quadrant,
      'the 0..100 projection must agree with the rule quadrant',
    );
  });

  it('a task created without scores carries source "rule", not "agent"', () => {
    const db = freshDb();
    const task = createTask(db, { title: '写季度复盘笔记' });
    assert.equal(task.quadrant_source, 'rule');
    assert.equal(task.matrix_score_source, 'rule');
    assert.equal(task.quadrant_confirmed, false);
    assert.notEqual(task.matrix_score_source, 'agent');
  });

  it('re-suggesting keeps the rule label and resets confirmation', () => {
    const db = freshDb();
    const created = createTask(db, { title: '整理收件箱' });
    // 手动移动象限已停用；它必须拒绝，且不妨碍随后的规则复评。
    assert.throws(() => changeQuadrant(db, created.id, 'q1', '用户先手动指定'), /复评|未写入/);
    const resuggested = resuggestQuadrant(db, created.id);
    assert.equal(resuggested.quadrant_source, 'rule');
    assert.equal(resuggested.matrix_score_source, 'rule');
    assert.equal(resuggested.quadrant_confirmed, false);
  });
});

describe('matrix score — persistence derives the quadrant once', () => {
  let db: Db;
  before(() => {
    withTempHabits();
    db = freshDb();
  });

  it('stores an agent score as an unconfirmed suggestion', () => {
    const task = createTask(db, { title: '修复结算回归' });
    const scored = scoreTaskMatrix(db, task.id, AGENT_SCORE);
    assert.equal(scored.matrix_importance_score, 82);
    assert.equal(scored.matrix_urgency_score, 71.5);
    assert.equal(scored.matrix_score_source, 'agent');
    assert.equal(scored.quadrant, 'q1');
    assert.equal(scored.quadrant_confirmed, false, 'agent 评分必须等待用户确认');
    assert.equal(scored.matrix_score_version, 1);
    assert.match(scored.matrix_score_reason ?? '', /季度目标/);
  });

  it('a user-sourced score is its own confirmation', () => {
    const task = createTask(db, { title: '预约牙医' });
    const scored = scoreTaskMatrix(db, task.id, {
      ...AGENT_SCORE,
      importance_score: 20,
      urgency_score: 10,
      source: 'user',
      reason: '用户明确表示这件事不重要也不紧急。',
    });
    assert.equal(scored.quadrant, 'q4');
    assert.equal(scored.matrix_score_source, 'user');
    assert.equal(scored.quadrant_confirmed, true);
  });

  it('re-scoring moves the quadrant and bumps the score version', () => {
    const task = createTask(db, { title: '调研缓存方案' });
    const first = scoreTaskMatrix(db, task.id, {
      ...AGENT_SCORE,
      importance_score: 80,
      urgency_score: 20,
    });
    assert.equal(first.quadrant, 'q2');
    const second = scoreTaskMatrix(db, task.id, {
      ...AGENT_SCORE,
      importance_score: 80,
      urgency_score: 90,
      reason: '上游把截止时间提前到明天，紧急度显著上升。',
    });
    assert.equal(second.quadrant, 'q1', '改分必须同步更新象限');
    assert.equal(second.matrix_score_version, 2);
  });

  it('rejects a stale expected_version without writing', () => {
    const task = createTask(db, { title: '更新依赖' });
    assert.throws(
      () => scoreTaskMatrix(db, task.id, { ...AGENT_SCORE, expected_version: task.version + 99 }),
      /期望版本/,
    );
    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_score_source, 'rule', '失败的评分不得落盘');
  });

  it('creating with an agent score never shows a rule score first', () => {
    const task = createTask(db, { title: '准备董事会材料', matrix_score: AGENT_SCORE });
    assert.equal(task.matrix_score_source, 'agent');
    assert.equal(task.matrix_importance_score, 82);
    assert.equal(task.quadrant, 'q1');
    assert.equal(task.quadrant_confirmed, false);
  });

  it('explicit legacy importance/urgency decide the quadrant, not the suggestion', () => {
    // The title reads as a q1 incident; the user's own 1/1 must win.
    const task = createTask(db, {
      title: 'URGENT production incident blocking the release',
      importance: 1,
      urgency: 1,
    });
    assert.equal(task.quadrant, 'q4');
    assert.equal(task.quadrant_source, 'user');
    assert.equal(task.quadrant_confirmed, true);
  });

  it('updating importance/urgency re-derives the quadrant', () => {
    const task = createTask(db, { title: '写周报', importance: 2, urgency: 2 });
    assert.equal(task.quadrant, 'q4');
    const updated = updateTask(db, task.id, { importance: 5, urgency: 5 });
    assert.equal(updated.quadrant, 'q1', '改分后象限必须跟着更新');
  });

  it('changeQuadrant refuses to write any score and keeps everything unchanged', () => {
    const task = createTask(db, { title: '回复合作方邮件' });
    const before = findTask(db, task.id)!;

    assert.throws(() => changeQuadrant(db, task.id, 'q3'), /复评|未写入/);

    // 逐位比对：拒绝的那次调用一个字节都不许落库。
    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.quadrant_confirmed, before.quadrant_confirmed);
    assert.equal(after.quadrant, before.quadrant);
    assert.equal(after.quadrant_source, before.quadrant_source);
    assert.equal(after.matrix_score_source, before.matrix_score_source);
    assert.equal(after.matrix_score_version, before.matrix_score_version);
    assert.equal(after.importance, before.importance);
    assert.equal(after.urgency, before.urgency);
    assert.equal(after.version, before.version, '拒绝的写入不得提升版本号');
  });

  it('records the score change in the operations log via the HTTP layer contract', () => {
    // scoreTaskMatrix itself is wrapped by withOperation in routes.ts; here we
    // assert the fields that log entry reads are all present.
    const task = createTask(db, { title: '梳理季度 OKR' });
    const scored = scoreTaskMatrix(db, task.id, AGENT_SCORE);
    assert.ok(scored.matrix_scored_at, '评分时间必须落盘');
    assert.ok(scored.matrix_score_reason);
    assert.equal(scored.matrix_score_confidence, 0.8);
  });
});

describe('matrix score — migration', () => {
  before(() => withTempHabits());

  it('maps legacy values inside the band its quadrant implies', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      assert.ok(legacyScoreFor(value, true) >= 50, `high ${value} must stay high`);
      assert.ok(legacyScoreFor(value, false) < 50, `low ${value} must stay low`);
    }
  });

  it('backfills legacy rows without changing their classification', () => {
    const db = freshDb();
    const task = createTask(db, { title: '历史任务', importance: 4, urgency: 2 });
    // Simulate a pre-migration row: quadrant kept, continuous scores missing.
    db.prepare(
      `UPDATE tasks SET matrix_importance_score = NULL, matrix_urgency_score = NULL,
         matrix_score_source = 'unset', matrix_score_reason = NULL WHERE id = ?`,
    ).run(task.id);

    const report = migrateTasksMatrixScores(db);
    assert.equal(report.rows_backfilled, 1);

    const migrated = findTask(db, task.id)!;
    assert.equal(migrated.quadrant, 'q2', '迁移不得改变原分类');
    assert.equal(migrated.matrix_score_source, 'legacy');
    assert.match(migrated.matrix_score_reason ?? '', /旧版粗评分，待助手复评/);
    assert.equal(
      quadrantFromScores(migrated.matrix_importance_score!, migrated.matrix_urgency_score!),
      'q2',
    );
  });

  it('is safe to re-run and preserves ids, status, claims and user scores', () => {
    const db = freshDb();
    const legacy = createTask(db, { title: '旧任务', importance: 5, urgency: 5 });
    db.prepare(
      'UPDATE tasks SET matrix_importance_score = NULL, matrix_urgency_score = NULL WHERE id = ?',
    ).run(legacy.id);
    const agentScored = createTask(db, { title: '新任务', matrix_score: AGENT_SCORE });

    const first = migrateTasksMatrixScores(db);
    const second = migrateTasksMatrixScores(db);

    assert.equal(first.rows_backfilled, 1);
    assert.equal(second.rows_backfilled, 0, '重复执行必须是空操作');
    assert.equal(second.columns_added.length, 0);

    const stillThere = findTask(db, legacy.id)!;
    assert.equal(stillThere.id, legacy.id);
    assert.equal(stillThere.title, '旧任务');
    assert.equal(stillThere.status, 'inbox');

    const untouched = findTask(db, agentScored.id)!;
    assert.equal(untouched.matrix_score_source, 'agent', '真实评分不得被迁移覆盖');
    assert.equal(untouched.matrix_importance_score, 82);
  });

  it('never overturns a user-confirmed quadrant', () => {
    const db = freshDb();
    const task = createTask(db, { title: '用户已确认的任务' });

    // 手动移动象限不再是取得"已确认"的途径——它必须拒绝且不写任何东西。
    assert.throws(() => changeQuadrant(db, task.id, 'q3', '用户坚持这是别人的急事'), /复评|未写入/);
    const refused = findTask(db, task.id)!;
    assert.equal(refused.quadrant_confirmed, false);
    assert.equal(refused.matrix_score_source, 'rule');

    // 真正的确认只能来自带理由的真实评分（这里是用户自己给的两轴分数）。
    const confirmed = scoreTaskMatrix(db, task.id, {
      ...AGENT_SCORE,
      importance_score: 20,
      urgency_score: 80,
      source: 'user',
      reason: '用户坚持这是别人的急事：不重要但很紧急。',
    });
    assert.equal(confirmed.quadrant, 'q3');

    db.prepare(
      'UPDATE tasks SET matrix_importance_score = NULL, matrix_urgency_score = NULL WHERE id = ?',
    ).run(task.id);

    migrateTasksMatrixScores(db);
    const after = findTask(db, task.id)!;
    assert.equal(after.quadrant, 'q3', '迁移不得改变原分类');
    assert.equal(after.quadrant_confirmed, true);
    assert.equal(after.quadrant_source, 'user');
  });

  it('leaves unclassified rows unscored rather than inventing a score', () => {
    const db = freshDb();
    const task = createTask(db, { title: '待评分任务' });
    db.prepare(
      `UPDATE tasks SET quadrant = NULL, matrix_importance_score = NULL,
         matrix_urgency_score = NULL, matrix_score_source = 'unset' WHERE id = ?`,
    ).run(task.id);

    migrateTasksMatrixScores(db);
    const row = get<Row>(db, 'SELECT * FROM tasks WHERE id = ?', [task.id])!;
    assert.equal(row.matrix_importance_score, null);
    assert.equal(row.matrix_score_source, 'unset');
  });
});
