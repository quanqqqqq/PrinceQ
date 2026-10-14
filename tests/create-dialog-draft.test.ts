/**
 * 「新建任务」对话框高级项折叠摘要的语义测试（UX-15）。
 *
 * 覆盖：
 *   - 高级项全空 → 视为未设置，摘要为空串
 *   - 单项设置 → 摘要只含该项的中文标签
 *   - manual_priority 的 '0' / '' 都不算设置，'-1' / '2' 算设置
 *   - 三项全设 → 摘要按 ` · ` 连接三个中文标签
 *   - 与 isCreateTaskDraftEmpty 的 manual_priority 口径一致
 *
 * 纯逻辑测试，不挂载组件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCED_SUMMARY_SEPARATOR,
  createAdvancedSummary,
  hasAdvancedCreateFields,
  isManualPrioritySet,
  type AdvancedCreateFields,
} from '../src/lib/create-form-summary.ts';
import {
  EMPTY_CREATE_TASK_DRAFT,
  isCreateTaskDraftEmpty,
} from '../src/lib/task-draft.ts';

/** 默认高级项：与 EMPTY_CREATE_TASK_DRAFT 的三个键一致（优先级默认档 '0'）。 */
const advanced = (overrides: Partial<AdvancedCreateFields> = {}): AdvancedCreateFields => ({
  task_type: '',
  cognitive_load: '',
  manual_priority: '0',
  ...overrides,
});

// ── 全空：折叠区没有任何内容需要提示 ────────────────────────────────────────

test('UX-15: 高级项全空时视为未设置，摘要为空串', () => {
  const fields = advanced();
  assert.equal(hasAdvancedCreateFields(fields), false);
  assert.equal(createAdvancedSummary(fields), '');
});

test('UX-15: 空草稿的三个高级键同样算未设置', () => {
  // 直接拿空草稿当输入，确保两个模块对「默认档位」的理解没有分叉。
  assert.equal(hasAdvancedCreateFields(EMPTY_CREATE_TASK_DRAFT), false);
  assert.equal(createAdvancedSummary(EMPTY_CREATE_TASK_DRAFT), '');
});

// ── 单项设置：摘要只说这一项 ────────────────────────────────────────────────

test('UX-15: 仅设认知负荷时摘要含「认知负荷=高」，不含类型与优先级', () => {
  const fields = advanced({ cognitive_load: 'high' });
  assert.equal(hasAdvancedCreateFields(fields), true);

  const summary = createAdvancedSummary(fields);
  assert.ok(summary.includes('认知负荷=高'), `摘要应包含认知负荷：${summary}`);
  assert.ok(!summary.includes('类型='), `摘要不应提到类型：${summary}`);
  assert.ok(!summary.includes('优先级='), `摘要不应提到优先级：${summary}`);
  // 只有一项时不该出现分隔符。
  assert.ok(!summary.includes(ADVANCED_SUMMARY_SEPARATOR), `单项摘要不应有分隔符：${summary}`);
});

test('UX-15: 仅设类型时摘要用 TASK_TYPE_LABELS 的中文名', () => {
  const summary = createAdvancedSummary(advanced({ task_type: 'review' }));
  assert.ok(summary.includes('类型=评审'), summary);
  assert.ok(!summary.includes('认知负荷='), summary);
});

// ── 手动优先级的口径：'0' 与 '' 不算设置 ───────────────────────────────────

test("UX-15: manual_priority 的 '0' 与 '' 都不算已设置", () => {
  for (const value of ['0', '']) {
    assert.equal(isManualPrioritySet(value), false, `${JSON.stringify(value)} 不该算已设置`);

    const fields = advanced({ manual_priority: value });
    assert.equal(hasAdvancedCreateFields(fields), false);
    assert.equal(createAdvancedSummary(fields), '');
  }
});

test("UX-15: manual_priority 为 '-1' / '2' 时算已设置并给出中文档位名", () => {
  const lower = advanced({ manual_priority: '-1' });
  assert.equal(isManualPrioritySet('-1'), true);
  assert.equal(hasAdvancedCreateFields(lower), true);
  assert.ok(createAdvancedSummary(lower).includes('优先级=较低'), createAdvancedSummary(lower));

  const high = advanced({ manual_priority: '2' });
  assert.equal(isManualPrioritySet('2'), true);
  assert.equal(hasAdvancedCreateFields(high), true);
  assert.ok(createAdvancedSummary(high).includes('优先级=高'), createAdvancedSummary(high));
});

test("UX-15: 优先级档位名里不含数字括号（纯中文语义文案）", () => {
  for (const value of ['-2', '-1', '0', '1', '2']) {
    const summary = createAdvancedSummary(advanced({ manual_priority: value }));
    assert.ok(!/[（(]/.test(summary), `档位 ${value} 的摘要不应带括号：${summary}`);
    assert.ok(!/[+\d]/.test(summary.replace('优先级=', '')), `档位 ${value} 不应露数字：${summary}`);
  }
});

// ── 三项全设：顺序与分隔符 ──────────────────────────────────────────────────

test('UX-15: 三个高级项都设时摘要同时包含三项中文标签，用 ` · ` 连接', () => {
  const summary = createAdvancedSummary(
    advanced({ task_type: 'review', cognitive_load: 'high', manual_priority: '1' }),
  );

  assert.ok(summary.startsWith('已设置：'), summary);
  assert.ok(summary.includes('类型=评审'), summary);
  assert.ok(summary.includes('认知负荷=高'), summary);
  assert.ok(summary.includes('优先级=较高'), summary);
  // 三项 → 两个分隔符。
  assert.equal(summary.split(ADVANCED_SUMMARY_SEPARATOR).length - 1, 2, summary);
});

// ── 与 UX-21 草稿语义的一致性 ───────────────────────────────────────────────

test('UX-15: 高级项被设置时草稿不再算空（两个模块口径一致）', () => {
  const cases: Partial<AdvancedCreateFields>[] = [
    { task_type: 'review' },
    { cognitive_load: 'low' },
    { manual_priority: '-2' },
  ];

  for (const patch of cases) {
    const fields = { ...EMPTY_CREATE_TASK_DRAFT, ...patch };
    assert.equal(hasAdvancedCreateFields(fields), true, JSON.stringify(patch));
    assert.equal(isCreateTaskDraftEmpty(fields), false, JSON.stringify(patch));
  }
});

test('UX-15: 高级项全空时草稿仍算空，摘要也为空（不会误显示摘要行）', () => {
  assert.equal(isCreateTaskDraftEmpty(EMPTY_CREATE_TASK_DRAFT), true);
  assert.equal(createAdvancedSummary(EMPTY_CREATE_TASK_DRAFT), '');
});
