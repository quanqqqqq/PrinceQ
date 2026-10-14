/**
 * 复评流程测试：请求 → 建议 → 确认，分数只在最后一步落库。
 *
 * 全部跑在内存库加临时 habits 目录上，用户真实的 `data/work-queue.db` 与
 * `habits/` 永不被触碰。`rescoring_requests` 这张表也只在这里按需建出来——
 * 运行时主库不建表（见 `server/repo/rescoring-service.ts` 文件头）。
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { all, type Db } from '../server/db/connection.ts';
import {
  axesMismatchingQuadrant,
  mergeAgentScores,
  validateChangedAxes,
} from '../server/domain/rescoring.ts';
import {
  cancelRescoringRequest,
  confirmRescoringRequest,
  createRescoringRequest,
  describeRescoringContext,
  ensureRescoringSchema,
  findRescoringRequest,
  listRescoringRequests,
  migrateRescoringSchema,
  submitRescoringSuggestion,
} from '../server/repo/rescoring-service.ts';
import { addDependency, createTask } from '../server/repo/task-service.ts';
import { createGoal } from '../server/repo/goal-service.ts';
import { findTask } from '../server/repo/tasks.ts';
import { DEFAULT_ACTOR_ID } from '../server/config.ts';
import { freshDb, withTempHabits } from './helpers.ts';

/** 一个已有真实两轴分数的任务，作为复评的起点。 */
const SCORED = {
  importance_score: 80,
  urgency_score: 30,
  reason: '影响季度目标，但没有近期截止时间。',
  source: 'agent' as const,
  confidence: 0.7,
};

let keyCounter = 0;
const nextKey = (): string => `resc-test-${(keyCounter += 1)}`;

const scoredTask = (db: Db, title: string) =>
  createTask(db, { title, matrix_score: SCORED });

describe('rescoring domain — 只动被请求的轴', () => {
  it('validateChangedAxes 拒绝空、重复和未知的轴', () => {
    assert.deepEqual(validateChangedAxes(['importance']), ['importance']);
    assert.deepEqual(validateChangedAxes(['urgency', 'importance']), ['importance', 'urgency']);
    assert.throws(() => validateChangedAxes([]), /至少一根/);
    assert.throws(() => validateChangedAxes('importance'), /至少一根/);
    assert.throws(() => validateChangedAxes(['importance', 'importance']), /重复/);
    assert.throws(() => validateChangedAxes(['quadrant']), /只能是/);
  });

  it('被请求的轴必须给值，未请求的轴逐位保留', () => {
    const merged = mergeAgentScores(
      { importance_score: 80, urgency_score: 30 },
      ['urgency'],
      { urgency_score: 92.5 },
    );
    assert.deepEqual(merged, { importance_score: 80, urgency_score: 92.5 });

    assert.throws(
      () => mergeAgentScores({ importance_score: 80, urgency_score: 30 }, ['urgency'], {}),
      /没有给出该轴的分数/,
    );
  });

  it('未请求的轴提交了不同值就整次拒绝', () => {
    assert.throws(
      () =>
        mergeAgentScores({ importance_score: 80, urgency_score: 30 }, ['urgency'], {
          urgency_score: 92.5,
          importance_score: 10,
        }),
      /未请求修改的轴 importance/,
    );
    // 提交了相同的值视为没动，允许通过。
    assert.deepEqual(
      mergeAgentScores({ importance_score: 80, urgency_score: 30 }, ['urgency'], {
        urgency_score: 92.5,
        importance_score: 80,
      }),
      { importance_score: 80, urgency_score: 92.5 },
    );
  });

  it('未请求又没有原值的轴直接报错，而不是编一个分数', () => {
    assert.throws(
      () =>
        mergeAgentScores({ importance_score: null, urgency_score: 30 }, ['urgency'], {
          urgency_score: 92.5,
        }),
      /没有分数可以保留/,
    );
  });

  it('被请求的轴仍然要过 0..100 与 1 位小数的校验', () => {
    const current = { importance_score: 80, urgency_score: 30 };
    assert.throws(() => mergeAgentScores(current, ['urgency'], { urgency_score: 120 }), /超出范围/);
    assert.throws(() => mergeAgentScores(current, ['urgency'], { urgency_score: 72.55 }), /1 位小数/);
    assert.throws(() => mergeAgentScores(current, ['urgency'], { urgency_score: '90' }), /必须是/);
  });
});

describe('rescoring service — 确认之前绝不写 tasks', () => {
  let db: Db;
  before(() => {
    withTempHabits();
    db = freshDb();
    ensureRescoringSchema(db);
  });

  it('只请求 importance：确认后 urgency 逐位不变、象限按新分派生', () => {
    const task = scoredTask(db, '重写季度规划文档');
    assert.equal(task.quadrant, 'q2', '起点：重要但不紧急');

    const request = createRescoringRequest(db, task.id, { changed_axes: ['importance'] });
    assert.equal(request.status, 'pending');
    assert.deepEqual(request.changed_axes, ['importance']);
    assert.equal(request.before_importance, 80);
    assert.equal(request.before_urgency, 30);

    submitRescoringSuggestion(db, request.id, {
      importance_score: 20,
      reason: '季度目标已改，这件事不再影响交付。',
      confidence: 0.6,
      agent_name: 'reviewer-agent',
    });

    const confirmed = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, nextKey());
    assert.equal(confirmed.request.status, 'done');
    assert.equal(confirmed.task.matrix_importance_score, 20, '请求的轴被更新');
    assert.equal(confirmed.task.matrix_urgency_score, 30, '未请求的轴逐位不变');
    // 20/30 两轴都低 → q4，象限只能由分数派生。
    assert.equal(confirmed.task.quadrant, 'q4');
    assert.equal(confirmed.task.quadrant_confirmed, true);
    assert.equal(confirmed.task.matrix_score_source, 'agent');
    assert.equal(confirmed.task.matrix_score_version, 2, '原本是 1，确认后 +1');
    assert.match(confirmed.task.matrix_score_reason ?? '', /reviewer-agent/);
  });

  it('Agent 顺带改了未请求的轴：submit 被拒，请求仍 pending，tasks 未动', () => {
    const task = scoredTask(db, '核对上月账单');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    const before = findTask(db, task.id)!;

    assert.throws(
      () =>
        submitRescoringSuggestion(db, request.id, {
          urgency_score: 95,
          importance_score: 10,
          reason: '顺手把重要程度也调低了。',
          agent_name: 'overreaching-agent',
        }),
      /未请求修改的轴 importance/,
    );

    assert.equal(
      findRescoringRequest(db, request.id)!.status,
      'pending',
      '被拒的提交必须把请求留在 pending，Agent 可以带正确的轴重试',
    );
    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.version, before.version, '被拒的提交不得提升任务版本');
    assert.equal(after.matrix_score_version, before.matrix_score_version);
  });

  it('未 submit 就 confirm：拒绝', () => {
    const task = scoredTask(db, '预约年度体检');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    const before = findTask(db, task.id)!;

    assert.throws(
      () => confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, nextKey()),
      /还没有收到真实 Agent 的建议/,
    );

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.version, before.version);
  });

  it('submit 之后、confirm 之前，tasks 里的分数纹丝不动', () => {
    const task = scoredTask(db, '整理去年报销凭证');
    const before = findTask(db, task.id)!;
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });

    const submitted = submitRescoringSuggestion(db, request.id, {
      urgency_score: 96,
      reason: '财务说本周五截止，再不交就作废。',
      agent_name: 'reviewer-agent',
    });
    assert.equal(submitted.status, 'awaiting_confirm');
    assert.equal(submitted.after_urgency, 96, '建议本身存在请求行里');
    assert.equal(submitted.after_importance, 80, '未请求的轴在建议里保留原值');

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score, '确认前不得写库');
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.quadrant, before.quadrant);
    assert.equal(after.quadrant_confirmed, false);
    assert.equal(after.version, before.version);
    assert.equal(after.matrix_score_version, before.matrix_score_version);
  });

  it('expected_version 过期：confirm 拒绝且不写', () => {
    const task = scoredTask(db, '更新团队 onboarding 文档');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    submitRescoringSuggestion(db, request.id, {
      urgency_score: 88,
      reason: '新人下周一入职，必须提前准备好。',
      agent_name: 'reviewer-agent',
    });

    // 期间任务被别的写入改过：这份建议是基于过时信息做的。
    db.prepare('UPDATE tasks SET version = version + 1 WHERE id = ?').run(task.id);
    const before = findTask(db, task.id)!;

    assert.throws(
      () => confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, nextKey()),
      /复评请求基于版本|未写入任何分数/,
    );

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.matrix_score_version, before.matrix_score_version);
    assert.equal(after.version, before.version, '回滚后版本号也不许动');
  });

  it('同一请求重复 confirm：幂等，不重复加分', () => {
    const task = scoredTask(db, '续签云服务合同');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    submitRescoringSuggestion(db, request.id, {
      urgency_score: 91,
      reason: '合同月底到期，逾期服务会中断。',
      agent_name: 'reviewer-agent',
    });

    const key = nextKey();
    const first = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, key);
    const second = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, key);

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, '同一 key 的第二次必须是重放');
    assert.equal(second.task.matrix_urgency_score, first.task.matrix_urgency_score);
    assert.equal(second.task.matrix_score_version, first.task.matrix_score_version, '不得重复 +1');
    assert.equal(second.task.version, first.task.version);

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_urgency_score, 91);
    assert.equal(after.matrix_score_version, first.task.matrix_score_version);
  });

  it('取消只标状态，tasks 一个字节都不动', () => {
    const task = scoredTask(db, '调研备选供应商');
    const before = findTask(db, task.id)!;
    const request = createRescoringRequest(db, task.id, { changed_axes: ['importance'] });
    submitRescoringSuggestion(db, request.id, {
      importance_score: 95,
      reason: '现供应商涨价，备选方案变得关键。',
      agent_name: 'reviewer-agent',
    });

    const cancelled = cancelRescoringRequest(db, request.id);
    assert.equal(cancelled.status, 'cancelled');

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.version, before.version);

    // 取消之后不能再确认。
    assert.throws(
      () => confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, nextKey()),
      /已取消/,
    );
  });
});

describe('axesMismatchingQuadrant — 象限只决定"该重评哪根轴"', () => {
  it('只有真正跨线的轴才进入结果', () => {
    // (30, 80) = 重要低、紧急高 → 当前落在 q3（不重要但紧急）。
    const current = { importance_score: 30, urgency_score: 80 };

    // 目标 q3：两根轴都已经在目标那一侧，没有轴需要动。
    assert.deepEqual(axesMismatchingQuadrant(current, 'q3'), []);
    // 目标 q1（重要且紧急）：紧急已经够高，只有重要跨线。
    assert.deepEqual(axesMismatchingQuadrant(current, 'q1'), ['importance']);
    // 目标 q4（都低）：重要已经够低，只有紧急跨线。
    assert.deepEqual(axesMismatchingQuadrant(current, 'q4'), ['urgency']);
    // 目标 q2（重要不紧急）：两根都站错了边。
    assert.deepEqual(axesMismatchingQuadrant(current, 'q2'), ['importance', 'urgency']);
  });

  it('50 是高的一侧（与 quadrantFromScores 同一条中线）', () => {
    const onLine = { importance_score: 50, urgency_score: 50 };
    // 两根都算"高" → 已经在 q1，无需重评。
    assert.deepEqual(axesMismatchingQuadrant(onLine, 'q1'), []);
    assert.deepEqual(axesMismatchingQuadrant(onLine, 'q4'), ['importance', 'urgency']);
  });

  it('没有原值的轴一律算不匹配——没有东西可保留，必须请 Agent 评', () => {
    assert.deepEqual(
      axesMismatchingQuadrant({ importance_score: null, urgency_score: 80 }, 'q3'),
      ['importance'],
    );
    assert.deepEqual(
      axesMismatchingQuadrant({ importance_score: null, urgency_score: null }, 'q1'),
      ['importance', 'urgency'],
    );
  });
});

describe('rescoring service — 第三轮补全的签名', () => {
  let db: Db;
  before(() => {
    withTempHabits();
    db = freshDb();
    ensureRescoringSchema(db);
  });

  it('migrateRescoringSchema 幂等：第二次调用不再建表也不报错', () => {
    const again = migrateRescoringSchema(db);
    assert.equal(again.created, false, '表已存在时 created 必须是 false');
    // 再调一次仍然安全。
    assert.doesNotThrow(() => migrateRescoringSchema(db));
  });

  it('只给 target_quadrant：changed_axes 自动算出', () => {
    // (80, 80)：两轴都高，当前 q1。目标 q3「不重要但紧急」要求重要低、紧急高，
    // 所以紧急已经匹配、只有重要跨线 → 自动算出 ['importance']。
    const task = createTask(db, {
      title: '回复合作方的询价邮件',
      matrix_score: {
        importance_score: 80,
        urgency_score: 80,
        reason: '对方催得紧，暂时也被当成重要的事。',
        source: 'agent' as const,
      },
    });
    assert.equal(task.quadrant, 'q1');

    const request = createRescoringRequest(db, task.id, { target_quadrant: 'q3' as const });
    assert.deepEqual(request.changed_axes, ['importance'], '只有跨线的重要轴被请求');
    assert.equal(request.target_quadrant, 'q3');
    assert.equal(request.before_importance, 80);
    assert.equal(request.before_urgency, 80);
    assert.equal(request.status, 'pending');
  });

  it('当前分数已落在目标象限：拒绝发起空复评', () => {
    // (30, 80) 本来就是 q3，目标还是 q3 → 没有轴需要动。
    const task = createTask(db, {
      title: '确认活动场地档期',
      matrix_score: {
        importance_score: 30,
        urgency_score: 80,
        reason: '对方催得紧，但对季度目标影响有限。',
        source: 'agent' as const,
      },
    });
    assert.equal(task.quadrant, 'q3');

    assert.throws(
      () => createRescoringRequest(db, task.id, { target_quadrant: 'q3' as const }),
      /已经落在目标象限里/,
    );
    assert.equal(
      listRescoringRequests(db).filter((item) => item.task_id === task.id).length,
      0,
      '被拒的创建不许留下任何请求行',
    );
  });

  it('target_quadrant 与 changed_axes 都不给 → badRequest', () => {
    const task = scoredTask(db, '盘点办公室耗材');
    assert.throws(() => createRescoringRequest(db, task.id, {}), /必须给出目标象限/);
    assert.equal(
      listRescoringRequests(db).filter((item) => item.task_id === task.id).length,
      0,
      '被拒的创建不许留下任何请求行',
    );
  });

  it('全链路：create(target=q1) → 上下文 → submit 只给 importance → confirm', () => {
    const goal = createGoal(db, { title: '把计费系统迁到新架构' });
    const blocker = createTask(db, { title: '梳理现有计费链路' });
    // (30, 80)：紧急已经够高，目标 q1 下只有重要需要重评。
    const task = createTask(db, {
      title: '评估双写方案的回滚成本',
      description: '需要确认回滚窗口与数据校验口径。',
      goal_id: goal.id,
      matrix_score: {
        importance_score: 30,
        urgency_score: 80,
        reason: '目前被当成临时救火，重要性待复核。',
        source: 'agent' as const,
      },
    });
    addDependency(db, task.id, blocker.id);
    const afterDependency = findTask(db, task.id)!;

    const request = createRescoringRequest(db, task.id, { target_quadrant: 'q1' as const });
    assert.deepEqual(request.changed_axes, ['importance'], '只有跨线的重要轴被请求');

    // ── 交给外部 Agent 的上下文：标题/目标/依赖/习惯摘要 ──
    const context = describeRescoringContext(db, request.id);
    assert.equal(context.task.title, '评估双写方案的回滚成本');
    assert.equal(context.task.description, '需要确认回滚窗口与数据校验口径。');
    assert.equal(context.goal_title, '把计费系统迁到新架构');
    assert.equal(context.depends_on.length, 1);
    assert.equal(context.depends_on[0].title, '梳理现有计费链路');
    assert.equal(context.depends_on[0].status, 'inbox');
    assert.match(context.habits_summary, /启用中的明确习惯 \d+ 条/);
    assert.match(context.habits_summary, /评分权重项/);

    // ── 外部 Agent 只给被请求的那根轴 ──
    const submitted = submitRescoringSuggestion(db, request.id, {
      importance_score: 72,
      reason: '它是迁移的前置判断，直接影响季度目标能否按时交付。',
      confidence: 0.8,
      agent_name: 'reviewer-agent',
    });
    assert.equal(submitted.status, 'awaiting_confirm', '中间态：等用户确认');
    assert.equal(submitted.after_importance, 72);
    assert.equal(submitted.after_urgency, 80, '未请求的轴在建议里保留原值');

    // ── 中间态：tasks 一个字节都没动 ──
    const mid = findTask(db, task.id)!;
    assert.equal(mid.matrix_importance_score, 30, 'confirm 之前分数纹丝不动');
    assert.equal(mid.quadrant, 'q3');
    assert.equal(mid.quadrant_confirmed, false);
    assert.equal(mid.version, afterDependency.version, '提交复评不应改变添加依赖后的任务版本');

    // ── 用户确认，这才落库 ──
    const confirmed = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, nextKey());
    assert.equal(confirmed.request.status, 'done');
    assert.equal(confirmed.task.matrix_importance_score, 72, '请求的轴被更新');
    assert.equal(confirmed.task.matrix_urgency_score, 80, '未请求的轴逐位保留');
    // 72/80 两轴都高 → q1，象限由分数派生而来，不是从 target_quadrant 抄的。
    assert.equal(confirmed.task.quadrant, 'q1');
    assert.equal(confirmed.task.quadrant_confirmed, true);
    assert.equal(confirmed.task.matrix_score_source, 'agent');
    assert.match(confirmed.task.matrix_score_reason ?? '', /reviewer-agent/);
  });

  it('Agent 顺带提交未请求轴的不同值 → submit 被拒、请求仍 pending', () => {
    const task = scoredTask(db, '更新报销流程说明');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    const before = findTask(db, task.id)!;

    assert.throws(
      () =>
        submitRescoringSuggestion(db, request.id, {
          urgency_score: 88,
          importance_score: 12,
          reason: '顺手把重要程度也调低了。',
          agent_name: 'overreaching-agent',
        }),
      /未请求修改的轴 importance/,
    );

    assert.equal(findRescoringRequest(db, request.id)!.status, 'pending');
    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.version, before.version);
  });

  it('重复 confirm 幂等：不加分，也不重复写 operations', () => {
    const task = scoredTask(db, '准备季度汇报材料');
    const request = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });
    submitRescoringSuggestion(db, request.id, {
      urgency_score: 93,
      reason: '汇报定在下周二，时间已经压到眼前。',
      agent_name: 'reviewer-agent',
    });

    const key = nextKey();
    const first = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, key);
    const countAfterFirst = all(
      db,
      `SELECT id FROM operations WHERE operation_type = 'task.matrix.rescore.confirm' AND target_id = ?`,
      [task.id],
    ).length;

    const second = confirmRescoringRequest(db, request.id, DEFAULT_ACTOR_ID, key);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, '同一 key 的第二次必须是重放');
    assert.equal(second.task.matrix_urgency_score, first.task.matrix_urgency_score);
    assert.equal(second.task.matrix_score_version, first.task.matrix_score_version, '不得重复 +1');
    assert.equal(second.task.version, first.task.version);

    const countAfterSecond = all(
      db,
      `SELECT id FROM operations WHERE operation_type = 'task.matrix.rescore.confirm' AND target_id = ?`,
      [task.id],
    ).length;
    assert.equal(countAfterSecond, countAfterFirst, '重放不得再写一条 operations');
  });

  it('同一任务已有 pending 时重复 create → badRequest', () => {
    const task = scoredTask(db, '重新谈机房续租');
    const first = createRescoringRequest(db, task.id, { changed_axes: ['urgency'] });

    assert.throws(
      () => createRescoringRequest(db, task.id, { changed_axes: ['importance'] }),
      /已有进行中的复评请求/,
    );

    // awaiting_confirm 同样算"在途"。
    submitRescoringSuggestion(db, first.id, {
      urgency_score: 85,
      reason: '租约下月到期，需要尽快决定。',
      agent_name: 'reviewer-agent',
    });
    assert.throws(
      () => createRescoringRequest(db, task.id, { changed_axes: ['importance'] }),
      /已有进行中的复评请求/,
    );

    // 取消之后就能重新发起了。
    cancelRescoringRequest(db, first.id);
    assert.doesNotThrow(() =>
      createRescoringRequest(db, task.id, { changed_axes: ['importance'] }),
    );
  });

  it('cancel 后 tasks 未动，列表里状态为 cancelled', () => {
    const task = scoredTask(db, '清理旧的监控告警规则');
    const before = findTask(db, task.id)!;
    const request = createRescoringRequest(db, task.id, { target_quadrant: 'q4' as const });
    submitRescoringSuggestion(db, request.id, {
      importance_score: 15,
      reason: '这批规则已经没人看了，重要性很低。',
      agent_name: 'reviewer-agent',
    });

    const cancelled = cancelRescoringRequest(db, request.id);
    assert.equal(cancelled.status, 'cancelled');

    const after = findTask(db, task.id)!;
    assert.equal(after.matrix_importance_score, before.matrix_importance_score);
    assert.equal(after.matrix_urgency_score, before.matrix_urgency_score);
    assert.equal(after.quadrant, before.quadrant);
    assert.equal(after.version, before.version, '取消不许动任务版本');

    assert.ok(
      listRescoringRequests(db, { status: 'cancelled' }).some((item) => item.id === request.id),
      'listRescoringRequests 能按状态过滤出它',
    );
  });

  it('listRescoringRequests 按状态过滤，pending 的请求都还没有 after_*', () => {
    for (const item of listRescoringRequests(db, { status: 'pending' })) {
      assert.equal(item.status, 'pending');
      assert.equal(item.after_importance, null, 'pending 阶段不许有任何建议分数');
      assert.equal(item.after_urgency, null);
      assert.equal(item.agent_name, null);
    }
  });
});
