/**
 * UX-14：队列卡片「为什么优先」默认只露两条最关键理由。
 *
 * topReasonFactors 是纯函数：按 |贡献| 降序挑 N 条，忽略零贡献因子；
 * reasonSummary 压成一行短理由。完整评分依据仍在展开面板 / 详情抽屉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reasonSummary, topReasonFactors } from '../shared/queue-reasons.ts';
import type { ScoreBreakdown } from '../shared/types.ts';

function makeBreakdown(factors: [string, string, number][]): ScoreBreakdown {
  return {
    task_id: 't1',
    score: 0,
    factors: factors.map(([key, label, contribution]) => ({
      key,
      label,
      value: 1,
      weight: 1,
      contribution,
      detail: '',
    })),
    notes: [],
    computed_at: new Date().toISOString(),
  };
}

test('默认只返回两条，按 |贡献| 降序（含把名次压下去的负贡献）', () => {
  const breakdown = makeBreakdown([
    ['effort', '工作量适中', 0.4],
    ['deadline', '截止紧迫', 2.3],
    ['context_switch', '上下文切换', -1.6],
    ['habit_alignment', '习惯契合', 0.2],
  ]);

  const top = topReasonFactors(breakdown, 2);
  assert.deepEqual(
    top.map((f) => f.key),
    ['deadline', 'context_switch'],
  );
});

test('零贡献因子不进短理由', () => {
  const breakdown = makeBreakdown([
    ['deadline', '截止紧迫', 2.3],
    ['manual_priority', '手动优先级', 0],
    ['effort', '工作量适中', 0.9],
  ]);
  const top = topReasonFactors(breakdown, 2);
  assert.deepEqual(
    top.map((f) => f.key),
    ['deadline', 'effort'],
  );
});

test('理由数少于 limit 时全返回；limit=0 为空', () => {
  const breakdown = makeBreakdown([['deadline', '截止紧迫', 2.3]]);
  assert.equal(topReasonFactors(breakdown, 2).length, 1);
  assert.equal(topReasonFactors(breakdown, 0).length, 0);
});

test('reasonSummary 带符号，负贡献显示负号', () => {
  const pos = makeBreakdown([['deadline', '截止紧迫', 2.345]]).factors[0];
  const neg = makeBreakdown([['context_switch', '上下文切换', -1.6]]).factors[0];
  assert.equal(reasonSummary(pos), '截止紧迫 +2.3');
  assert.equal(reasonSummary(neg), '上下文切换 -1.6');
});
