/**
 * 设置页纯逻辑层的单元测试。
 *
 * 只覆盖 `settings-contract.ts`——标签映射、权重夹取与摘要、换算校验、置信度格式
 * 化。这些是设置页里唯一有分支的部分，而且不需要 DOM，所以能在 node:test 里直接跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTRAINT_KIND_LABELS,
  EXPLICIT_KIND_LABELS,
  clampWeight,
  confidenceLabel,
  isConversionValid,
  kindLabel,
  summarizeWeights,
} from '../src/components/settings/settings-contract.ts';

/** 摘要测试用的基线：六项全 1。 */
const BALANCED = {
  deadline: 1,
  manual_priority: 1,
  dependency: 1,
  effort: 1,
  habit_alignment: 1,
  context_switch: 1,
};

test('kindLabel 认识的 kind 给中文，不认识的原样返回', () => {
  assert.equal(kindLabel(EXPLICIT_KIND_LABELS, 'scheduling'), '时间安排');
  assert.equal(kindLabel(CONSTRAINT_KIND_LABELS, 'forbidden_window'), '禁止时段');
  // 后端随时可以新增 kind，界面不该因为不认识就显示空白。
  assert.equal(kindLabel(EXPLICIT_KIND_LABELS, 'brand_new_kind'), 'brand_new_kind');
  assert.equal(kindLabel(CONSTRAINT_KIND_LABELS, ''), '');
});

test('clampWeight 把任何输入压进 0/1/2 三档', () => {
  assert.equal(clampWeight(-1), 0);
  assert.equal(clampWeight(3.5), 2);
  assert.equal(clampWeight(1.2), 1);
  assert.equal(clampWeight(NaN), 0);
});

test('summarizeWeights 全平衡时直接说清这件事', () => {
  assert.equal(summarizeWeights(BALANCED), '全部保持平衡（1）');
});

test('summarizeWeights 只列出偏离默认档位的项', () => {
  const summary = summarizeWeights({ ...BALANCED, deadline: 2, effort: 0 });
  assert.ok(summary.includes('截止时间=优先'), summary);
  assert.ok(summary.includes('预计耗时=关闭'), summary);
  // 六个「=平衡」没有信息量，不该出现在摘要里。
  assert.ok(!summary.includes('=平衡'), summary);
});

test('isConversionValid 拒掉越界的换算系数', () => {
  assert.equal(isConversionValid(0.4, 20), false);
  assert.equal(isConversionValid(24.1, 20), false);
  assert.equal(isConversionValid(8, 0), false);
  assert.equal(isConversionValid(8, 32), false);
});

test('isConversionValid 接受边界值本身', () => {
  assert.equal(isConversionValid(0.5, 20), true);
  assert.equal(isConversionValid(24, 20), true);
  assert.equal(isConversionValid(8, 1), true);
  assert.equal(isConversionValid(8, 31), true);
});

test('isConversionValid 要求工作日是整数', () => {
  // 半个工作日没有意义，后端也按整数存。
  assert.equal(isConversionValid(8, 8.5), false);
  assert.equal(isConversionValid(8, 8), true);
});

test('confidenceLabel 把 0–1 的置信度格式成百分比', () => {
  assert.equal(confidenceLabel(0.62), '62%');
  assert.equal(confidenceLabel(null), '—');
  assert.equal(confidenceLabel(undefined), '—');
  assert.equal(confidenceLabel(NaN), '—');
});
